import * as web3 from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import {
  db,
  createUser,
  getUser,
  getUserByWallet,
  grantRole,
  parseRoles,
  setActiveRole,
  SELF_SERVICE_ROLES,
  type User,
  type UserRole,
} from "./db.ts";
import { config } from "./config.ts";
import { bad, conflict, forbidden, unauthorized, notFound, tooMany } from "./util.ts";
import { hashCode, verifyPassword, passwordProblem, safeEqual } from "./password.ts";
import { generateToken, hashToken } from "./tokens.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;

/** Every mode an account can hold. Shared by sign-up and wallet sign-in. */
const USER_ROLES: UserRole[] = ["client", "freelancer", "support", "dev"];

import type { AuthedRequest } from "./util.ts";
export type { AuthedRequest };
import { loadDemoKeypairByWallet } from "./demo-keys.ts";
import { saveUserKeypair, userKeypair } from "./keys.ts";

/** A `users` row as it exists in SQLite (includes the auth columns). */
type UserRow = User & { email_verified?: number; token_version?: number };

type AuthTokenKind = "email_verify" | "password_reset";

// ---------------------------------------------------------------------------
// Small primitives: normalisation, audit, lockout, one-time tokens
// ---------------------------------------------------------------------------
function normalizeEmail(v: unknown): string {
  if (typeof v !== "string") return "";
  const e = v.trim().toLowerCase();
  if (e.length > 254) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "";
  return e;
}

function normalizeUsername(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase();
}

function ipOf(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/** Append-only audit trail for authentication events. Never throws. */
export function recordAuthEvent(
  userId: number | null,
  event: string,
  req: Request,
  detail?: string,
): void {
  try {
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 250) : null;
    db.prepare(
      "INSERT INTO auth_events (user_id, event, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?)",
    ).run(userId, event, ipOf(req), ua, detail ?? null);
  } catch {
    /* auditing must never break a request */
  }
}

// --- brute-force lockout (per identifier) ----------------------------------
function lockState(identifier: string): { lockedUntil: number | null; failed: number } {
  const row = db
    .prepare("SELECT failed_count, locked_until FROM login_attempts WHERE identifier = ?")
    .get(identifier) as { failed_count: number; locked_until: number | null } | undefined;
  if (!row) return { lockedUntil: null, failed: 0 };
  if (row.locked_until && row.locked_until <= Date.now()) {
    db.prepare("DELETE FROM login_attempts WHERE identifier = ?").run(identifier);
    return { lockedUntil: null, failed: 0 };
  }
  return { lockedUntil: row.locked_until ?? null, failed: row.failed_count };
}

function registerFailure(identifier: string): void {
  const { failed } = lockState(identifier);
  const next = failed + 1;
  const lockedUntil =
    next >= config.lockoutThreshold ? Date.now() + config.lockoutMinutes * 60_000 : null;
  db.prepare(
    `INSERT INTO login_attempts (identifier, failed_count, locked_until, last_attempt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (identifier) DO UPDATE SET
       failed_count = excluded.failed_count,
       locked_until = excluded.locked_until,
       last_attempt = excluded.last_attempt`,
  ).run(identifier, next, lockedUntil, Date.now());
}

function clearFailures(identifier: string): void {
  db.prepare("DELETE FROM login_attempts WHERE identifier = ?").run(identifier);
}

// --- one-time tokens --------------------------------------------------------
function issueAuthToken(userId: number, kind: AuthTokenKind): string {
  const token = generateToken();
  const expiresAt = Date.now() + config.authTokenTtlMinutes * 60_000;
  // Invalidate any outstanding tokens of the same kind for this user.
  db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL").run(userId, kind);
  db.prepare(
    "INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES (?, ?, ?, ?)",
  ).run(userId, kind, hashToken(token), expiresAt);
  return token;
}

function consumeAuthToken(token: string, kind: AuthTokenKind): { user_id: number } | undefined {
  const row = db
    .prepare(
      "SELECT id, user_id FROM auth_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(hashToken(token), kind, Date.now()) as { id: number; user_id: number } | undefined;
  if (!row) return undefined;
  db.prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return { user_id: row.user_id };
}

/** Only email the token in production; surface it in dev bodies for testing. */
function exposeToken(devOnly: string | undefined): string | undefined {
  return config.isProduction ? undefined : devOnly;
}

function bumpTokenVersion(userId: number): void {
  db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(userId);
}

async function syncUser(user: User): Promise<void> {
  try {
    const { syncUserToNeon } = await import("./neon.ts");
    await syncUserToNeon(user);
  } catch {
    /* Neon is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Account creation
// ---------------------------------------------------------------------------
function createCredentialAccount(
  email: string,
  password: string,
  role: User["role"],
  provider: "email" | "google",
  googleId?: string,
): { user: User; username: string; secretKeyB58: string | undefined } {
  const userRole: User["role"] =
    role === "client" || role === "freelancer" ? role : "freelancer";

  const kp = web3.Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const secretKeyB58 = config.exposeDemoSecretKeys ? bs58.encode(kp.secretKey) : undefined;

  const localPart = email.split("@")[0] || email;
  const username = localPart.toLowerCase().replace(/[^a-z0-9._-]/g, "_");

  const existingCred = db
    .prepare("SELECT user_id FROM user_credentials WHERE lower(username) = ? OR lower(email) = ?")
    .get(username, email);
  if (existingCred) throw conflict("an account with that email already exists");

  const user = createUser(wallet, userRole);
  db.prepare(
    "INSERT INTO user_credentials (user_id, username, password, email) VALUES (?, ?, ?, ?)",
  ).run(user.id, username, hashCode(password), email);

  // Verified immediately when the provider vouches for the address (Google).
  if (provider === "google") {
    db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(user.id);
  }

  db.prepare(
    `INSERT INTO client_profiles (user_id, organization, business_description, needs_summary)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  ).run(
    user.id,
    username + " Studio",
    provider === "google" ? "Signed up via Google" : "Escrow Marketplace Client",
    provider === "google" ? "Google OAuth signup" : "Email + password signup",
  );

  return { user: getUserByWallet(wallet) as UserRow, username, secretKeyB58 };
}

// ---------------------------------------------------------------------------
// Email + password signup
// Body: { email, password, role }
// ---------------------------------------------------------------------------
export function signupRoute(req: Request, res: Response): void {
  const { email, password, role } = (req.body ?? {}) as Record<string, unknown>;

  const emailAddr = normalizeEmail(email);
  if (!emailAddr) throw bad("a valid email address is required");
  const pwProblem = passwordProblem(password);
  if (pwProblem) throw bad(pwProblem);

  const finalRole: User["role"] =
    role === "client" || role === "freelancer" ? role : "freelancer";

  const { user, username, secretKeyB58 } = createCredentialAccount(
    emailAddr,
    password as string,
    finalRole,
    "email",
  );

  const verifyToken = issueAuthToken(user.id, "email_verify");
  recordAuthEvent(user.id, "signup", req, `role=${user.role}`);

  res.status(201).json({
    token: issueToken(user),
    user: publicUser(user),
    email: emailAddr,
    username,
    provider: "email",
    email_verified: false,
    verification_required: config.requireEmailVerification,
    verification_token: exposeToken(verifyToken),
    secret_key_b58: secretKeyB58,
  });
}

// ---------------------------------------------------------------------------
// Google-style social signup
// Body: { email, name, googleId }
// ---------------------------------------------------------------------------
export function socialSignupRoute(req: Request, res: Response): void {
  const { email, name, googleId } = (req.body ?? {}) as Record<string, unknown>;

  const emailAddr = normalizeEmail(email);
  if (!emailAddr) throw bad("a valid email address is required");
  if (typeof name !== "string" || name.trim().length === 0) throw bad("name is required");
  if (typeof googleId !== "string" || googleId.trim().length === 0)
    throw bad("googleId is required");

  const localPart = (emailAddr.split("@")[0] || emailAddr).toLowerCase();
  const username = localPart.replace(/[^a-z0-9._-]/g, "_");

  const existing = db
    .prepare(
      `SELECT u.id, c.user_id, u.wallet_address, u.role, u.status, u.created_at, u.email_verified
       FROM user_credentials c JOIN users u ON u.id = c.user_id
       WHERE lower(c.username) = ? OR lower(c.email) = ?`,
    )
    .get(username, emailAddr) as (UserRow & { user_id: number }) | undefined;

  if (existing) {
    if (existing.status === "suspended") throw forbidden("account suspended");
    recordAuthEvent(existing.user_id, "login", req, "provider=google");
    res.json({
      token: issueToken(existing),
      user: publicUser(existing),
      email: emailAddr,
      username,
      provider: "google",
      alreadyExists: true,
    });
    return;
  }

  const role: User["role"] = "freelancer";
  const kp = web3.Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const secretKeyB58 = config.exposeDemoSecretKeys ? bs58.encode(kp.secretKey) : undefined;

  const user = createUser(wallet, role);
  // Google verified the address, and there is no local password to guess: store
  // a hash of a random secret so no password can ever match it.
  db.prepare(
    "INSERT INTO user_credentials (user_id, username, password, email) VALUES (?, ?, ?, ?)",
  ).run(user.id, username, hashCode(generateToken()), emailAddr);
  db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(user.id);

  db.prepare(
    `INSERT INTO freelancer_profiles (user_id, headline, bio, degrees, languages, age, years_experience, hourly_rate_sol, points, portfolio_ready)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 350, 1)
     ON CONFLICT(user_id) DO UPDATE SET
       headline = excluded.headline, bio = excluded.bio, portfolio_ready = 1`,
  ).run(user.id, name.trim(), "Signed up via Google", "", "", 27, 3, 0.5);

  const fresh = getUserByWallet(wallet) as UserRow;
  void syncUser(fresh);
  recordAuthEvent(user.id, "signup", req, "provider=google");

  res.status(201).json({
    token: issueToken(fresh),
    user: publicUser(fresh),
    email: emailAddr,
    username,
    name: name.trim(),
    provider: "google",
    googleId,
    secret_key_b58: secretKeyB58,
  });
}

// ---------------------------------------------------------------------------
// External identity providers (Auth0 / OIDC)
// ---------------------------------------------------------------------------
export type ExternalIdentity = {
  provider: "auth0";
  /** The provider's stable user id (Auth0 `sub`). */
  subject: string;
  email: string;
  name?: string;
  /** Role used only when the account is created on the spot; existing accounts
   * keep the role they already have. */
  role?: User["role"];
};

export type ExternalSession = {
  created: boolean;
  session: {
    token: string;
    user: ReturnType<typeof publicUser>;
    username: string;
    email: string;
    provider: string;
    name?: string;
    secret_key_b58?: string;
  };
};

/**
 * Dev-only signing key for an existing account: the key persisted when the
 * account was created, falling back to the seeded demo keypairs.
 */
function signingKeyB58(userId: number, wallet: string): string | undefined {
  if (!config.exposeDemoSecretKeys) return undefined;
  try {
    return bs58.encode(userKeypair(userId, wallet).secretKey);
  } catch {
    return demoSecretKey(wallet);
  }
}

/**
 * Map an identity vouched for by an external provider onto a local account and
 * return a ready session. This is the single owner of that policy — the Auth0
 * routes contain no user-creation logic of their own.
 */
export function loginWithExternalIdentity(
  req: Request,
  identity: ExternalIdentity,
): ExternalSession {
  const emailAddr = normalizeEmail(identity.email);
  if (!emailAddr) throw bad("the identity provider did not return a usable email address");

  const existing = db
    .prepare(
      `SELECT u.id, u.wallet_address, u.role, u.status, u.created_at, u.email_verified,
              c.user_id, c.username, c.email
       FROM user_credentials c JOIN users u ON u.id = c.user_id
       WHERE lower(c.email) = ?`,
    )
    .get(emailAddr) as
    | (UserRow & { user_id: number; username: string; email: string | null })
    | undefined;

  if (existing) {
    if (existing.status === "suspended") throw forbidden("account suspended");
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(existing.user_id) as UserRow;
    recordAuthEvent(user.id, "login", req, `provider=${identity.provider}`);
    return {
      created: false,
      session: {
        token: issueToken(user),
        user: publicUser(user),
        username: existing.username,
        email: existing.email ?? emailAddr,
        provider: identity.provider,
        secret_key_b58: signingKeyB58(user.id, user.wallet_address),
      },
    };
  }

  const role: User["role"] =
    identity.role === "client" || identity.role === "freelancer" ? identity.role : "client";
  const kp = web3.Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const name = (identity.name || emailAddr.split("@")[0] || "member").trim();

  let username = (emailAddr.split("@")[0] || "member").toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  if (db.prepare("SELECT 1 FROM user_credentials WHERE lower(username) = ?").get(username)) {
    username = `${username}_${wallet.slice(0, 4).toLowerCase()}`;
  }

  const user = createUser(wallet, role);
  // Persist the keypair: without it the account could only ever sign during the
  // session that created it.
  saveUserKeypair(user.id, kp);
  db.prepare(
    "INSERT INTO user_credentials (user_id, username, password, email) VALUES (?, ?, ?, ?)",
  ).run(user.id, username, hashCode(generateToken()), emailAddr);
  db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(user.id);

  if (role === "freelancer") {
    db.prepare(
      `INSERT INTO freelancer_profiles (user_id, headline, bio, degrees, languages, age, years_experience, hourly_rate_sol, points, portfolio_ready)
       VALUES (?, ?, ?, '', '', 27, 3, 0.5, 350, 1)
       ON CONFLICT(user_id) DO UPDATE SET headline = excluded.headline, portfolio_ready = 1`,
    ).run(user.id, name, `Signed up via ${identity.provider}`);
  } else {
    db.prepare(
      `INSERT INTO client_profiles (user_id, organization, business_description, needs_summary)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).run(user.id, `${name} Studio`, `Signed up via ${identity.provider}`, `${identity.provider} OIDC signup`);
  }

  const fresh = getUserByWallet(wallet) as UserRow;
  void syncUser(fresh);
  recordAuthEvent(user.id, "signup", req, `provider=${identity.provider} sub=${identity.subject}`);

  return {
    created: true,
    session: {
      token: issueToken(fresh),
      user: publicUser(fresh),
      username,
      email: emailAddr,
      provider: identity.provider,
      name,
      secret_key_b58: config.exposeDemoSecretKeys ? bs58.encode(kp.secretKey) : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Admin signup — gated by a static setup secret (ADMIN_SETUP_SECRET)
// Body: { username, password }
// ---------------------------------------------------------------------------
export function adminSignupRoute(req: Request, res: Response): void {
  const configured = config.adminSetupSecret;
  if (!configured) {
    throw forbidden(
      "admin signup is disabled: set ADMIN_SETUP_SECRET to enable admin provisioning",
    );
  }

  const { username, password } = (req.body ?? {}) as Record<string, unknown>;
  const u = normalizeUsername(username);
  if (u.length < 3 || u.length > 32 || !/^[a-z0-9._-]+$/.test(u))
    throw bad("username must be 3-32 characters (letters, digits, . _ -)");
  const pwProblem = passwordProblem(password);
  if (pwProblem) throw bad(pwProblem);

  const provided = req.headers["x-admin-setup-secret"];
  if (typeof provided !== "string" || !safeEqual(provided, configured)) {
    recordAuthEvent(null, "admin_signup_denied", req, `username=${u}`);
    throw forbidden("invalid admin setup secret");
  }

  const existingCred = db
    .prepare("SELECT user_id FROM user_credentials WHERE lower(username) = ?")
    .get(u);
  if (existingCred) throw conflict("username already taken");

  const role: User["role"] = "dev";
  const kp = web3.Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const secretKeyB58 = config.exposeDemoSecretKeys ? bs58.encode(kp.secretKey) : undefined;

  const user = createUser(wallet, role);
  db.prepare(
    "INSERT INTO user_credentials (user_id, username, password, email) VALUES (?, ?, ?, NULL)",
  ).run(user.id, u, hashCode(password as string));
  db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(user.id);

  const fresh = getUserByWallet(wallet) as UserRow;
  void syncUser(fresh);
  recordAuthEvent(user.id, "admin_signup", req, `username=${u}`);

  res.status(201).json({
    token: issueToken(fresh),
    user: publicUser(fresh),
    username: u,
    provider: "admin",
    secret_key_b58: secretKeyB58,
  });
}

// ---------------------------------------------------------------------------
// Login — email or username + password
// Body: { email, password } or { username, password }
// ---------------------------------------------------------------------------
export function loginRoute(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = body.email;
  const username = body.username;
  const password = body.password;

  if (typeof password !== "string") throw bad("password is required");

  const emailStr = typeof email === "string" ? email.trim() : "";
  const usernameStr = typeof username === "string" ? username.trim() : "";
  if (emailStr.length > 0 && usernameStr.length > 0)
    throw bad("provide either email or username, not both");
  if (emailStr.length === 0 && usernameStr.length === 0)
    throw bad("email or username is required together with password");

  const identifier = emailStr.length > 0 ? normalizeEmail(emailStr) : normalizeUsername(usernameStr);
  if (!identifier) throw bad("a valid email address is required");

  // Refuse early if the identifier is currently locked out.
  const lock = lockState(identifier);
  if (lock.lockedUntil) {
    const minutes = Math.ceil((lock.lockedUntil - Date.now()) / 60_000);
    recordAuthEvent(null, "login_locked", req, `identifier=${identifier}`);
    throw tooMany(`too many failed attempts — try again in ${minutes} minute(s)`);
  }

  // `u.roles` and `u.token_version` must stay in this projection: `publicUser`
  // serialises `roles` (the account menu's mode list) and `issueToken` reads the
  // version off the row, both of which silently degrade to a single-role,
  // revoked-looking session when the column is missing from the join.
  const cols =
    "u.id, c.user_id, c.username, c.password, c.email, u.wallet_address, u.role, u.roles, u.status, u.created_at, u.email_verified";
  const base = `SELECT ${cols} FROM user_credentials c JOIN users u ON u.id = c.user_id`;

  let lookup: (UserRow & { user_id: number; username: string; password: string; email: string | null }) | undefined;
  if (emailStr.length > 0) {
    const localPart = identifier.split("@")[0] || identifier;
    lookup =
      (db.prepare(`${base} WHERE lower(c.email) = ?`).get(identifier) as typeof lookup) ??
      (db.prepare(`${base} WHERE lower(c.username) = ?`).get(localPart) as typeof lookup);
  } else {
    lookup = db.prepare(`${base} WHERE lower(c.username) = ?`).get(identifier) as typeof lookup;
  }

  if (!lookup) {
    registerFailure(identifier);
    recordAuthEvent(null, "login_failed", req, `identifier=${identifier} reason=no_account`);
    throw unauthorized("invalid email or password");
  }

  const verdict = verifyPassword(password, lookup.password);
  if (!verdict.ok) {
    registerFailure(identifier);
    recordAuthEvent(lookup.user_id, "login_failed", req, "reason=bad_password");
    throw unauthorized("invalid email or password");
  }

  if (lookup.status === "suspended") {
    recordAuthEvent(lookup.user_id, "login_denied", req, "reason=suspended");
    throw forbidden("account suspended");
  }

  if (config.requireEmailVerification && !lookup.email_verified) {
    recordAuthEvent(lookup.user_id, "login_denied", req, "reason=email_unverified");
    throw forbidden("email address is not verified");
  }

  // Upgrade legacy plaintext / stale-work-factor hashes transparently.
  if (verdict.needsRehash) {
    db.prepare("UPDATE user_credentials SET password = ? WHERE user_id = ?").run(
      hashCode(password),
      lookup.user_id,
    );
  }

  clearFailures(identifier);
  recordAuthEvent(lookup.user_id, "login", req, emailStr.length > 0 ? "identifier=email" : "identifier=username");

  const user = lookup as unknown as UserRow;
  const secretKeyB58 = config.exposeDemoSecretKeys ? demoSecretKey(user.wallet_address) : undefined;

  res.json({
    token: issueToken(user),
    user: publicUser(user),
    username: lookup.username,
    email: lookup.email ?? undefined,
    secret_key_b58: secretKeyB58,
  });
}

function demoSecretKey(wallet: string): string | undefined {
  try {
    const kp = loadDemoKeypairByWallet(wallet);
    return bs58.encode(kp.secretKey);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Session revocation
// ---------------------------------------------------------------------------
export function logoutRoute(req: Request, res: Response): void {
  const user = (req as AuthedRequest).user;
  if (user) {
    bumpTokenVersion(user.id);
    recordAuthEvent(user.id, "logout", req);
  }
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------
export function verifyEmailRoute(req: Request, res: Response): void {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token) throw bad("token is required");
  const consumed = consumeAuthToken(token, "email_verify");
  if (!consumed) throw bad("verification link is invalid or has expired");
  db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(consumed.user_id);
  recordAuthEvent(consumed.user_id, "email_verified", req);
  res.json({ ok: true, email_verified: true });
}

export function resendVerificationRoute(req: Request, res: Response): void {
  const user = (req as AuthedRequest).user!;
  const row = db.prepare("SELECT email_verified FROM users WHERE id = ?").get(user.id) as
    | { email_verified: number }
    | undefined;
  if (row?.email_verified) {
    res.json({ ok: true, already_verified: true });
    return;
  }
  const token = issueAuthToken(user.id, "email_verify");
  recordAuthEvent(user.id, "verification_resent", req);
  res.json({ ok: true, verification_token: exposeToken(token), email_sent: config.isProduction });
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------
export function forgotPasswordRoute(req: Request, res: Response): void {
  const emailAddr = normalizeEmail(req.body?.email);
  let resetToken: string | undefined;

  if (emailAddr) {
    const row = db
      .prepare(
        `SELECT c.user_id, u.status FROM user_credentials c JOIN users u ON u.id = c.user_id
         WHERE lower(c.email) = ? OR lower(c.username) = ?`,
      )
      .get(emailAddr, emailAddr.split("@")[0] || emailAddr) as
      | { user_id: number; status: User["status"] }
      | undefined;
    if (row && row.status === "active") {
      resetToken = issueAuthToken(row.user_id, "password_reset");
      recordAuthEvent(row.user_id, "password_reset_requested", req);
    }
  }

  // Always return the same shape so the endpoint cannot be used to enumerate accounts.
  res.json({
    ok: true,
    message: "If that account exists, a reset link has been sent.",
    reset_token: exposeToken(resetToken),
  });
}

export function resetPasswordRoute(req: Request, res: Response): void {
  const { token, password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || token.length === 0) throw bad("token is required");
  const pwProblem = passwordProblem(password);
  if (pwProblem) throw bad(pwProblem);

  const consumed = consumeAuthToken(token, "password_reset");
  if (!consumed) throw bad("reset link is invalid or has expired");

  db.prepare("UPDATE user_credentials SET password = ? WHERE user_id = ?").run(
    hashCode(password as string),
    consumed.user_id,
  );
  // Log every session out after a password change.
  bumpTokenVersion(consumed.user_id);
  const cred = db
    .prepare("SELECT username FROM user_credentials WHERE user_id = ?")
    .get(consumed.user_id) as { username: string } | undefined;
  if (cred) clearFailures(cred.username.toLowerCase());
  recordAuthEvent(consumed.user_id, "password_reset", req);
  res.json({ ok: true });
}

export function changePasswordRoute(req: Request, res: Response): void {
  const user = (req as AuthedRequest).user!;
  const { current_password, new_password } = (req.body ?? {}) as Record<string, unknown>;

  const cred = db
    .prepare("SELECT username, password FROM user_credentials WHERE user_id = ?")
    .get(user.id) as { username: string; password: string } | undefined;
  if (!cred) throw notFound("no password credentials for this account");

  if (typeof current_password !== "string" || !verifyPassword(current_password, cred.password).ok)
    throw unauthorized("current password is incorrect");

  const pwProblem = passwordProblem(new_password);
  if (pwProblem) throw bad(pwProblem);

  db.prepare("UPDATE user_credentials SET password = ? WHERE user_id = ?").run(
    hashCode(new_password as string),
    user.id,
  );
  recordAuthEvent(user.id, "password_changed", req);
  // Re-issue a token bound to the new version so the caller stays signed in.
  bumpTokenVersion(user.id);
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
  res.json({ ok: true, token: issueToken(fresh) });
}

// ---------------------------------------------------------------------------
// Wallet-sign + SIWS-style verify (unchanged core)
// ---------------------------------------------------------------------------
const pendingMessages = new Map<string, { message: string; expiresAt: number }>();

function purgeChallenges(): void {
  db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").run(Date.now());
  for (const [k, v] of pendingMessages)
    if (v.expiresAt < Date.now()) pendingMessages.delete(k);
}

function storeNonce(nonce: string, wallet: string, message: string): void {
  purgeChallenges();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  db.prepare(
    "INSERT INTO auth_challenges (nonce, wallet_address, expires_at) VALUES (?, ?, ?)",
  ).run(nonce, wallet, expiresAt);
  pendingMessages.set(nonce, { message, expiresAt });
}

function takeNonce(nonce: string): { wallet_address: string } | undefined {
  const row = db
    .prepare("SELECT wallet_address FROM auth_challenges WHERE nonce = ? AND expires_at > ?")
    .get(nonce, Date.now()) as { wallet_address: string } | undefined;
  if (row) db.prepare("DELETE FROM auth_challenges WHERE nonce = ?").run(nonce);
  return row;
}

export function buildSiwsMessage(wallet: string, nonce: string, chain: string): string {
  const issuedAt = new Date().toISOString();
  return [
    `${config.appOrigin} wants you to sign in with your Solana account:`,
    wallet,
    "",
    "Sign-in to the Solana Escrow Freelance Marketplace. This signature proves wallet ownership and authorizes a session. No blockchain transaction is submitted.",
    "",
    `URI: ${config.appOrigin}`,
    `Version: 1`,
    `Chain ID: ${chain}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

export function challengeRoute(req: Request, res: Response): void {
  const wallet = typeof req.body?.wallet === "string" ? req.body.wallet.trim() : "";
  try {
    new web3.PublicKey(wallet);
  } catch {
    throw bad("invalid wallet address");
  }
  const nonce = web3.Keypair.generate().publicKey.toBase58().slice(0, 32);
  const message = buildSiwsMessage(wallet, nonce, config.chain);
  storeNonce(nonce, wallet, message);
  res.json({ nonce, message });
}

export function verifyRoute(req: Request, res: Response): void {
  const { wallet, signature, nonce, role } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof wallet !== "string" || typeof signature !== "string" || typeof nonce !== "string") {
    throw bad("wallet, signature and nonce are required");
  }
  const stored = takeNonce(nonce);
  if (!stored || stored.wallet_address !== wallet) {
    throw unauthorized("challenge expired or wallet mismatch");
  }
  const pending = pendingMessages.get(nonce);
  pendingMessages.delete(nonce);
  const message = pending?.message ?? buildSiwsMessage(wallet, nonce, config.chain);
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signature),
      bs58.decode(wallet),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw unauthorized("signature verification failed");

  const existing = getUserByWallet(wallet) as UserRow | undefined;
  if (existing) {
    if (existing.status === "suspended") throw forbidden("account suspended");
    // Honour the mode the caller asked to enter as — but only one this account
    // already holds. A wallet signature proves *who* you are, never what you may
    // become, so an unknown mode is ignored rather than granted (granting lives
    // in `addRoleRoute`). Without this, the demo personas all drop you into
    // whatever mode was last active on the shared account.
    const wanted = typeof role === "string" && USER_ROLES.includes(role as UserRole)
      ? (role as UserRole)
      : null;
    if (wanted && wanted !== existing.role && parseRoles(existing).includes(wanted)) {
      const switched = (setActiveRole(existing.id, wanted) ?? existing) as UserRow;
      recordAuthEvent(switched.id, "mode_switch", req, `role=${wanted} via=wallet-sign`);
      res.json({ token: issueToken(switched), user: publicUser(switched), isNew: false });
      return;
    }
    recordAuthEvent(existing.id, "login", req, "wallet-sign");
    res.json({ token: issueToken(existing), user: publicUser(existing), isNew: false });
    return;
  }
  const userRole: User["role"] =
    typeof role === "string" && USER_ROLES.includes(role as UserRole) ? (role as UserRole) : "client";
  const anyoneElse = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (
    (userRole === "support" || userRole === "dev") &&
    anyoneElse.n > 0 &&
    !req.headers["x-staff-invite"]
  )
    throw forbidden("support/dev self-signup requires x-staff-invite header (demo gate)");
  const user = createUser(wallet, userRole) as UserRow;
  recordAuthEvent(user.id, "signup", req, `wallet-sign role=${user.role}`);
  res.json({ token: issueToken(user), user: publicUser(user), isNew: true });
}

// ---------------------------------------------------------------------------
// Tokens, public shape, and middleware
// ---------------------------------------------------------------------------
export function issueToken(user: User): string {
  // The version is read from the row rather than the object we were handed:
  // callers pass partial user shapes (join queries, cached reads) that carry no
  // `token_version`, and a stale `tv` mints a token `requireAuth` rejects on the
  // very next request — which locks a password sign-in out for good.
  const row = db.prepare("SELECT token_version FROM users WHERE id = ?").get(user.id) as
    | { token_version?: number }
    | undefined;
  const tv = row?.token_version ?? (user as UserRow).token_version ?? 0;
  return jwt.sign({ sub: String(user.id), role: user.role, tv }, config.jwtSecret, {
    expiresIn: config.accessTokenTtl as jwt.SignOptions["expiresIn"],
  });
}

export function publicUser(user: User) {
  const row = user as UserRow;
  return {
    id: user.id,
    wallet_address: user.wallet_address,
    role: user.role,
    // Every mode this account may switch into. The client renders its nav from this.
    roles: parseRoles(row),
    status: user.status,
    email_verified: row.email_verified === undefined ? true : Boolean(row.email_verified),
  };
}

/**
 * Switch the account's active mode (client <-> freelancer).
 *
 * Authorization reads the role off the `users` row (see `requireAuth`), not off
 * the token, so the switch takes effect immediately either way. The fresh token
 * is still returned so the JWT's `role` claim never drifts from the row that
 * actually decides anything.
 */
export function setModeRoute(req: Request, res: Response): void {
  const user = (req as AuthedRequest).user! as UserRow;
  const target = String((req.body ?? {}).role ?? "") as UserRole;
  if (!["client", "freelancer", "support", "dev"].includes(target)) {
    throw bad("role must be one of client, freelancer, support, dev");
  }
  if (!parseRoles(user).includes(target)) {
    throw forbidden(`this account is not set up for ${target} yet`);
  }
  if (user.role === target) {
    res.json({ token: issueToken(user), user: publicUser(user), switched: false });
    return;
  }
  const updated = setActiveRole(user.id, target) as UserRow | undefined;
  if (!updated) throw notFound("user no longer exists");
  recordAuthEvent(updated.id, "mode_switch", req, `role=${target}`);
  res.json({ token: issueToken(updated), user: publicUser(updated), switched: true });
}

/**
 * Grant a self-service mode the account may then switch into — "Become a
 * freelancer" / "Start hiring". Staff modes are never self-service: this only
 * ever accepts client or freelancer.
 *
 * Pass `activate: true` to grant and switch in one round trip.
 */
export function addRoleRoute(req: Request, res: Response): void {
  const user = (req as AuthedRequest).user! as UserRow;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = String(body.role ?? "") as UserRole;
  if (!SELF_SERVICE_ROLES.includes(target)) {
    throw bad(`role must be one of ${SELF_SERVICE_ROLES.join(", ")}`);
  }
  const granted = grantRole(user.id, target) as UserRow | undefined;
  if (!granted) throw notFound("user no longer exists");
  const activate = body.activate === true || body.activate === "true";
  let next: UserRow = granted;
  if (activate) next = (setActiveRole(granted.id, target) ?? granted) as UserRow;
  recordAuthEvent(next.id, "role_granted", req, `role=${target} activate=${activate}`);
  res.json({ token: issueToken(next), user: publicUser(next), granted: target, active: activate });
}

export function meRoute(req: Request, res: Response): void {
  const user = (req as AuthedRequest).user!;
  let profile: Record<string, unknown> = {};
  if (user.role === "client") {
    profile =
      (db.prepare("SELECT * FROM client_profiles WHERE user_id = ?").get(user.id) as
        | Record<string, unknown>
        | undefined) ?? {};
    // A dual-role account editing its profile still wants its freelancer side.
    if (parseRoles(user).includes("freelancer")) {
      profile.freelancer =
        db.prepare("SELECT * FROM freelancer_profiles WHERE user_id = ?").get(user.id) ?? null;
    }
  } else if (user.role === "freelancer") {
    profile =
      (db.prepare("SELECT * FROM freelancer_profiles WHERE user_id = ?").get(user.id) as
        | Record<string, unknown>
        | undefined) ?? {};
  }
  const cred = db
    .prepare("SELECT username, email FROM user_credentials WHERE user_id = ?")
    .get(user.id) as { username: string; email: string | null } | undefined;
  res.json({
    user: publicUser(user),
    profile,
    username: cred?.username,
    email: cred?.email ?? undefined,
  });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const reqA = req as AuthedRequest;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized("missing bearer token"));
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as {
      sub: string;
      role: User["role"];
      tv?: number;
    };
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub)) as
      | UserRow
      | undefined;
    if (!user) return next(unauthorized("user no longer exists"));
    if ((payload.tv ?? 0) !== (user.token_version ?? 0))
      return next(unauthorized("session has been revoked"));
    if (user.status === "suspended") return next(forbidden("account suspended"));
    reqA.user = user;
    next();
  } catch {
    next(unauthorized("invalid or expired token"));
  }
}

export function requireRole(...roles: User["role"][]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const reqA = req as AuthedRequest;
    if (!reqA.user) return next(unauthorized());
    if (!roles.includes(reqA.user.role))
      return next(forbidden(`requires role: ${roles.join(" or ")}`));
    next();
  };
}

export function maybeAuth(req: Request, _res: Response, next: NextFunction): void {
  const reqA = req as AuthedRequest;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string; tv?: number };
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub)) as
      | UserRow
      | undefined;
    if (user && user.status === "active" && (payload.tv ?? 0) === (user.token_version ?? 0))
      reqA.user = user;
  } catch {
    /* anonymous */
  }
  next();
}
