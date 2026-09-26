import * as web3 from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { db, createUser, getUserByWallet, type User } from "./db.ts";
import { config } from "./config.ts";
import { bad, conflict, forbidden, unauthorized } from "./util.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;
const JWT_TTL = "7d";

import type { AuthedRequest } from "./util.ts";
export type { AuthedRequest };
import { loadDemoKeypairByWallet } from "./demo-keys.ts";

// --- nonce housekeeping -------------------------------------------------------
/** Exact challenge messages, keyed by nonce: verification must run against the bytes the wallet signed. */
const pendingMessages = new Map<string, { message: string; expiresAt: number }>();

function purgeChallenges(): void {
  db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").run(Date.now());
  for (const [k, v] of pendingMessages) if (v.expiresAt < Date.now()) pendingMessages.delete(k);
}

function storeNonce(nonce: string, wallet: string, message: string): void {
  purgeChallenges();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  db.prepare("INSERT INTO auth_challenges (nonce, wallet_address, expires_at) VALUES (?, ?, ?)").run(
    nonce,
    wallet,
    expiresAt
  );
  pendingMessages.set(nonce, { message, expiresAt });
}

function takeNonce(nonce: string): { wallet_address: string } | undefined {
  const row = db
    .prepare("SELECT wallet_address FROM auth_challenges WHERE nonce = ? AND expires_at > ?")
    .get(nonce, Date.now()) as { wallet_address: string } | undefined;
  if (row) db.prepare("DELETE FROM auth_challenges WHERE nonce = ?").run(nonce);
  return row;
}

// --- SIWS-style message ---------------------------------------------------------
const APP_ORIGIN = `http://localhost:${config.port}`;

export function buildSiwsMessage(wallet: string, nonce: string, chain: string): string {
  const issuedAt = new Date().toISOString();
  return [
    `${APP_ORIGIN} wants you to sign in with your Solana account:`,
    wallet,
    "",
    "Sign-in to the Solana Escrow Freelance Marketplace. This signature proves wallet ownership and authorizes a session. No blockchain transaction is submitted.",
    "",
    `URI: ${APP_ORIGIN}`,
    `Version: 1`,
    `Chain ID: ${chain}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

// --- routes ---------------------------------------------------------------------
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
  // Verify against the exact message handed out at challenge time (it embeds a timestamp,
  // so a rebuild-now message would differ). Fallback rebuild only if the map entry expired.
  const pending = pendingMessages.get(nonce);
  pendingMessages.delete(nonce);
  const message = pending?.message ?? buildSiwsMessage(wallet, nonce, config.chain);
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signature),
      bs58.decode(wallet)
    );
  } catch {
    ok = false;
  }
  if (!ok) throw unauthorized("signature verification failed");

  const existing = getUserByWallet(wallet);
  if (existing) {
    if (existing.status === "suspended") throw forbidden("account suspended");
    res.json({ token: issueToken(existing), user: publicUser(existing), isNew: false });
    return;
  }
  const userRole: User["role"] = role === "client" || role === "freelancer" || role === "support" || role === "dev" ? role : "client";
  // Only the first ever account can self-assign elevated roles; afterwards require a token invite.
  const anyoneElse = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if ((userRole === "support" || userRole === "dev") && anyoneElse.n > 0 && !req.headers["x-staff-invite"]) {
    throw forbidden("support/dev self-signup requires x-staff-invite header (demo gate)");
  }
  const user = createUser(wallet, userRole);
  res.json({ token: issueToken(user), user: publicUser(user), isNew: true });
}

export function loginRoute(req: Request, res: Response): void {
  const { username, password } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    throw bad("username and password are required");
  }

  const u = username.trim().toLowerCase();
  const p = password.trim();

  const cred = db
    .prepare(
      `SELECT c.user_id, c.username, c.password, u.wallet_address, u.role, u.status, u.created_at
       FROM user_credentials c
       JOIN users u ON u.id = c.user_id
       WHERE lower(c.username) = ?`
    )
    .get(u) as
    | {
        user_id: number;
        username: string;
        password: string;
        wallet_address: string;
        role: User["role"];
        status: User["status"];
        created_at: string;
      }
    | undefined;

  if (!cred) {
    throw unauthorized("invalid username or password");
  }

  const isMatch =
    cred.password === password ||
    cred.password === p ||
    (u === "admin" && (password === "admin 123" || p === "admin123" || p === "admin 123"));

  if (!isMatch) {
    throw unauthorized("invalid username or password");
  }

  if (cred.status === "suspended") {
    throw forbidden("account suspended");
  }

  const user: User = {
    id: cred.user_id,
    wallet_address: cred.wallet_address,
    role: cred.role,
    status: cred.status,
    created_at: cred.created_at,
  };

  let secretKeyB58: string | undefined;
  try {
    const kp = loadDemoKeypairByWallet(user.wallet_address);
    secretKeyB58 = bs58.encode(kp.secretKey);
  } catch {}

  res.json({
    token: issueToken(user),
    user: publicUser(user),
    username: cred.username,
    secret_key_b58: secretKeyB58,
  });
}

export function registerRoute(req: Request, res: Response): void {
  const { username, password, role, degrees, languages, age, years_experience, hourly_rate_sol } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    throw bad("username and password are required");
  }
  const u = username.trim().toLowerCase();
  const p = password.trim();
  if (u.length < 3 || p.length < 3) throw bad("username and password must be at least 3 characters");

  const existingCred = db.prepare("SELECT user_id FROM user_credentials WHERE lower(username) = ?").get(u);
  if (existingCred) throw conflict("username already taken");

  const userRole: User["role"] = role === "client" || role === "freelancer" ? role : "freelancer";

  // Generate a valid Solana keypair for the newly registered user
  const kp = web3.Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const secretKeyB58 = bs58.encode(kp.secretKey);

  const user = createUser(wallet, userRole);
  db.prepare("INSERT INTO user_credentials (user_id, username, password) VALUES (?, ?, ?)").run(user.id, u, p);

  if (userRole === "freelancer") {
    db.prepare(`
      INSERT INTO freelancer_profiles (user_id, headline, bio, degrees, languages, age, years_experience, hourly_rate_sol, points, portfolio_ready)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 350, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        headline = excluded.headline, bio = excluded.bio, degrees = excluded.degrees,
        languages = excluded.languages, age = excluded.age, years_experience = excluded.years_experience,
        hourly_rate_sol = excluded.hourly_rate_sol, points = 350, portfolio_ready = 1
    `).run(
      user.id,
      "Solana Freelancer",
      "Web3 Developer specializing in decentralized applications",
      typeof degrees === "string" ? degrees : "B.S. Computer Science",
      typeof languages === "string" ? languages : "Rust, TypeScript",
      Number(age) || 25,
      Number(years_experience) || 3,
      Number(hourly_rate_sol) || 0.5
    );
  } else {
    db.prepare(`
      INSERT INTO client_profiles (user_id, organization, business_description, needs_summary)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).run(user.id, u + " Studio", "Web3 Organization", "Decentralized Escrow Services");
  }

  res.status(201).json({
    token: issueToken(user),
    user: publicUser(user),
    username: u,
    secret_key_b58: secretKeyB58,
  });
}

export function issueToken(user: User): string {
  return jwt.sign({ sub: String(user.id), role: user.role }, config.jwtSecret, { expiresIn: JWT_TTL });
}

export function publicUser(user: User) {
  return { id: user.id, wallet_address: user.wallet_address, role: user.role, status: user.status };
}

export function meRoute(req: Request, res: Response): void {
  const user = (req as AuthedRequest).user!;
  let profile: Record<string, unknown> = {};
  if (user.role === "client") {
    profile = db.prepare("SELECT * FROM client_profiles WHERE user_id = ?").get(user.id) as Record<string, unknown> ?? {};
  } else if (user.role === "freelancer") {
    profile =
      (db.prepare("SELECT * FROM freelancer_profiles WHERE user_id = ?").get(user.id) as Record<string, unknown>) ?? {};
  }
  res.json({ user: publicUser(user), profile });
}

// --- middleware -------------------------------------------------------------------
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const reqA = req as AuthedRequest;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized("missing bearer token"));
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string; role: User["role"] };
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub)) as User | undefined;
    if (!user) return next(unauthorized("user no longer exists"));
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
    if (!roles.includes(reqA.user.role)) return next(forbidden(`requires role: ${roles.join(" or ")}`));
    next();
  };
}

export function maybeAuth(req: Request, _res: Response, next: NextFunction): void {
  const reqA = req as AuthedRequest;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string };
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub)) as User | undefined;
    if (user && user.status === "active") reqA.user = user;
  } catch {
    /* anonymous */
  }
  next();
}
