/**
 * Auth0 (OIDC) sign-in — the hosted "Sign in with Auth0" path on the login page.
 *
 * Flow: /auth/auth0/login → Auth0 Universal Login → /auth/auth0/callback, where
 * the authorization code is exchanged for tokens, the profile is read from
 * /userinfo, and the person is mapped onto a local account by
 * `loginWithExternalIdentity`. The finished app session is handed to the browser
 * through a one-time code that the login page trades in via
 * /auth/auth0/handoff (the app keeps its session in sessionStorage, so the server
 * cannot set it directly).
 *
 * All of this stays dormant until AUTH0_ISSUER_BASE_URL, AUTH0_CLIENT_ID and
 * AUTH0_CLIENT_SECRET are configured; the login page then advertises
 * "AUTH0 · READY" instead of falling back to demo personas.
 */
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config.ts";
import { loginWithExternalIdentity } from "./auth.ts";
import { HttpError, bad } from "./util.ts";

/** Authorization requests awaiting their callback, keyed by OAuth `state`. */
type PendingTx = { verifier: string; next?: string; role?: string; expiresAt: number };

/**
 * In-process stores. Fine for this single-process server; a multi-instance
 * deployment would move both maps into the shared database.
 */
const pending = new Map<string, PendingTx>();
const handoffs = new Map<string, { payload: Record<string, unknown>; expiresAt: number }>();

const TX_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 60_000;
const TX_COOKIE = "solhustle.auth0.tx";

function prune(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  for (const [k, v] of handoffs) if (v.expiresAt < now) handoffs.delete(k);
}

const randomId = (bytes: number) => crypto.randomBytes(bytes).toString("base64url");
const challengeFor = (verifier: string) =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

/**
 * What the login page needs to know: is the hosted path live, for which tenant,
 * and which URLs this deployment actually calls back to — the "not configured"
 * notice has to name the real ones, or it sends people to whitelist a path the
 * server does not serve.
 */
export function auth0Meta(): {
  configured: boolean;
  domain: string | null;
  redirectUri: string;
  logoutReturnTo: string;
  callbackPath: string;
  /** Both origins, when they disagree — the login page reports the round trip as broken. */
  originMismatch: { servingOrigin: string; callbackOrigin: string } | null;
} {
  const { issuerBaseUrl, redirectUri, callbackPath } = config.auth0;
  return {
    configured: config.auth0.configured,
    domain: issuerBaseUrl ? issuerBaseUrl.replace(/^https?:\/\//, "") : null,
    redirectUri,
    logoutReturnTo: config.auth0LogoutReturnTo,
    callbackPath,
    originMismatch: config.auth0.originMismatch,
  };
}

/** Only same-origin, path-style targets may survive the round trip to Auth0. */
function safeNext(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > 300) return undefined;
  return /^\/(?!\/)/.test(v) ? v : undefined;
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function writeCookie(res: Response, name: string, value: string, maxAgeMs: number): void {
  const bits = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (config.isProduction) bits.push("Secure");
  const prev = res.getHeader("set-cookie");
  const list = prev === undefined ? [] : Array.isArray(prev) ? [...prev] : [String(prev)];
  res.setHeader("set-cookie", [...list, bits.join("; ")]);
}

/** Config triple that must exist before anything here can run. */
function auth0Config() {
  const a = config.auth0;
  if (!a.configured || !a.issuerBaseUrl || !a.clientId || !a.clientSecret) {
    throw bad(
      "Auth0 is not configured: set AUTH0_ISSUER_BASE_URL, AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET",
    );
  }
  return { issuerBaseUrl: a.issuerBaseUrl, clientId: a.clientId, clientSecret: a.clientSecret, redirectUri: a.redirectUri };
}

// ---------------------------------------------------------------------------
// Step 1 — send the browser to Auth0 Universal Login
// ---------------------------------------------------------------------------
export function auth0LoginRoute(req: Request, res: Response): void {
  const a = auth0Config();
  prune();

  const state = randomId(24);
  const verifier = randomId(32);
  pending.set(state, {
    verifier,
    next: safeNext(req.query.next),
    role: typeof req.query.role === "string" ? req.query.role : undefined,
    expiresAt: Date.now() + TX_TTL_MS,
  });
  writeCookie(res, TX_COOKIE, state, TX_TTL_MS);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    scope: "openid profile email",
    state,
    // PKCE protects the code exchange even though this client also has a secret.
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
  });
  res.redirect(302, `${a.issuerBaseUrl}/authorize?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Step 2 — Auth0 redirects back with a code
// ---------------------------------------------------------------------------
async function exchangeCode(code: string, verifier: string): Promise<string> {
  const a = auth0Config();
  const res = await fetch(`${a.issuerBaseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: a.clientId,
      client_secret: a.clientSecret,
      code,
      redirect_uri: a.redirectUri,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(502, `Auth0 token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text) as { access_token?: string };
  if (!parsed.access_token) {
    throw new HttpError(502, "Auth0 token response contained no access_token");
  }
  return parsed.access_token;
}

type Auth0Profile = { sub: string; email?: string; name?: string; nickname?: string };

async function fetchProfile(accessToken: string): Promise<Auth0Profile> {
  const a = auth0Config();
  const res = await fetch(`${a.issuerBaseUrl}/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(502, `Auth0 userinfo failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as Auth0Profile;
}

export async function auth0CallbackRoute(req: Request, res: Response): Promise<void> {
  const toLogin = (message: string) =>
    res.redirect(302, `/login?error=${encodeURIComponent(message)}`);

  if (!config.auth0.configured) return toLogin("Auth0 is not configured on this server");

  const { error, error_description: description, code, state } = req.query as Record<
    string,
    string | undefined
  >;
  if (error) return toLogin(description || error);

  prune();
  const tx = state ? pending.get(state) : undefined;
  if (!code || !state || !tx || tx.expiresAt < Date.now()) {
    return toLogin("this sign-in attempt expired — please try again");
  }
  // One-time use: a replayed callback can never mint a second session.
  pending.delete(state);
  if (readCookie(req, TX_COOKIE) !== state) {
    return toLogin("this sign-in attempt did not start in this browser — please try again");
  }
  writeCookie(res, TX_COOKIE, "", 0);

  try {
    const accessToken = await exchangeCode(code, tx.verifier);
    const profile = await fetchProfile(accessToken);
    if (!profile.email) return toLogin("Auth0 returned no email address for this account");

    const { session, created } = loginWithExternalIdentity(req, {
      provider: "auth0",
      subject: profile.sub,
      email: profile.email,
      name: profile.name || profile.nickname,
      role: tx.role === "freelancer" ? "freelancer" : "client",
    });

    const handoff = randomId(18);
    handoffs.set(handoff, { payload: session, expiresAt: Date.now() + HANDOFF_TTL_MS });

    const query = new URLSearchParams({ auth0: handoff });
    if (tx.next) query.set("next", tx.next);
    if (created) query.set("created", "1");
    res.redirect(302, `/login?${query.toString()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Auth0 sign-in failed";
    console.error("[auth0] callback failed:", message);
    return toLogin(config.isProduction ? "Auth0 sign-in failed" : message);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — the login page trades the one-time code for its session
// ---------------------------------------------------------------------------
export function auth0HandoffRoute(req: Request, res: Response): void {
  prune();
  const code = String(req.body?.code ?? "");
  const entry = code ? handoffs.get(code) : undefined;
  if (!entry || entry.expiresAt < Date.now()) {
    throw bad("this sign-in link has expired — start again");
  }
  handoffs.delete(code);
  res.json({ ok: true, ...entry.payload });
}

/**
 * End the local session AND end the Auth0 session (federated logout).
 * Logout URL: https://<tenant>.us.auth0.com/v2/logout?client_id=<id>&returnTo=<encoded-return-path>
 */
export function auth0LogoutRoute(req: Request, res: Response): void {
  const a = auth0Config();
  const origin = config.appOrigin;
  const returnTo = config.auth0LogoutReturnTo;

  const logoutUrl = `${a.issuerBaseUrl}/v2/logout?client_id=${encodeURIComponent(a.clientId)}&returnTo=${encodeURIComponent(returnTo)}`
    + `&federated`;
  // Redirect the browser to Auth0's logout endpoint, which clears its session cookie.
  res.redirect(302, logoutUrl);
}
