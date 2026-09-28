import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

/**
 * Authentication end-to-end tests.
 *
 * These boot the real server against a throwaway data directory (and an
 * unreachable Postgres so the Neon mirror stays out of the way) and drive the
 * HTTP API exactly as a browser would.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));

function findFreePortSync(): number {
  const srv = net.createServer();
  srv.listen(0);
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 8799;
  srv.close();
  return port;
}

const PORT = String(findFreePortSync());

const childEnv = {
  ...process.env,
  PORT,
  DATA_DIR: tmp,
  KEYS_DIR: tmp,
  NODE_ENV: "development",
  JWT_SECRET: "test-secret-value-for-auth-tests",
  ADMIN_SETUP_SECRET: "test-admin-secret",
  // Fail fast instead of touching the real Neon database from tests.
  DATABASE_URL: "postgresql://user:pass@127.0.0.1:1/none",
  SEED_DEMO_ACCOUNTS: "false",
};

const server = spawn(
  process.execPath,
  ["--experimental-strip-types", "--experimental-transform-types", "server/server.ts"],
  { env: childEnv, cwd: path.resolve(import.meta.dirname, "../..") },
);

const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/meta/network`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}

server.stderr.on("data", (d) => {
  const s = String(d);
  if (!/Neon|SSL|ExperimentalWarning|trace-warnings|libpq/.test(s)) process.stderr.write(s);
});

function json(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const suffix = Math.random().toString(36).slice(2, 8);
const email = (n: string) => `auth.${n}.${suffix}@example.com`;
const PASSWORD = "Str0ng-Pass!";

before(async () => {
  await waitForServer();
});

after(async () => {
  server.kill("SIGKILL");
  // Give the child a moment to release its SQLite handles (Windows keeps them
  // locked briefly after the process is signalled).
  await new Promise((r) => setTimeout(r, 400));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup; the OS reclaims the temp dir anyway */
  }
});

test("signup stores a salted scrypt hash, never the plaintext", async () => {
  const res = await json("POST", "/auth/signup", { email: email("hash"), password: PASSWORD, role: "client" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.provider, "email");
  assert.equal(body.user.role, "client");

  const db = new DatabaseSync(path.join(tmp, "app.db"));
  const row = db
    .prepare("SELECT password FROM user_credentials WHERE username = ?")
    .get(body.username) as { password: string } | undefined;
  assert.ok(row, "credential row exists");
  assert.ok(row!.password.startsWith("scrypt$"), "password is scrypt-hashed");
  assert.ok(!row!.password.includes(PASSWORD), "plaintext is not present");
  db.close();
});

test("login by email and by username both work", async () => {
  const e = email("login");
  const created = await json("POST", "/auth/signup", { email: e, password: PASSWORD, role: "freelancer" });
  const { username } = await created.json();

  const byEmail = await json("POST", "/auth/login", { email: e, password: PASSWORD });
  assert.equal(byEmail.status, 200);

  const byUsername = await json("POST", "/auth/login", { username, password: PASSWORD });
  assert.equal(byUsername.status, 200);
});

test("weak passwords are rejected", async () => {
  const res = await json("POST", "/auth/signup", { email: email("weak"), password: "alllowercase", role: "client" });
  assert.equal(res.status, 400);
});

test("duplicate email is rejected", async () => {
  const e = email("dup");
  assert.equal((await json("POST", "/auth/signup", { email: e, password: PASSWORD, role: "client" })).status, 201);
  assert.equal((await json("POST", "/auth/signup", { email: e, password: PASSWORD, role: "client" })).status, 409);
});

test("email verification consumes a single-use token", async () => {
  const res = await json("POST", "/auth/signup", { email: email("verify"), password: PASSWORD, role: "client" });
  const { verification_token } = await res.json();
  assert.ok(verification_token, "dev build returns a verification token");

  assert.equal((await json("POST", "/auth/verify-email", { token: verification_token })).status, 200);
  // Second use must fail - tokens are single-use.
  assert.equal((await json("POST", "/auth/verify-email", { token: verification_token })).status, 400);
});

test("password reset issues a token, changes the password, and invalidates the old one", async () => {
  const e = email("reset");
  await json("POST", "/auth/signup", { email: e, password: PASSWORD, role: "client" });

  const forgot = await json("POST", "/auth/forgot-password", { email: e });
  assert.equal(forgot.status, 200);
  const { reset_token } = await forgot.json();
  assert.ok(reset_token, "dev build returns a reset token");

  const reset = await json("POST", "/auth/reset-password", { token: reset_token, password: "N3w-Passw0rd!" });
  assert.equal(reset.status, 200);

  assert.equal((await json("POST", "/auth/login", { email: e, password: PASSWORD })).status, 401);
  assert.equal((await json("POST", "/auth/login", { email: e, password: "N3w-Passw0rd!" })).status, 200);
});

test("forgot-password does not reveal whether an account exists", async () => {
  const a = await json("POST", "/auth/forgot-password", { email: email("nobody") });
  const b = await json("POST", "/auth/forgot-password", { email: email("reset") });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(await a.json().then((x) => x.message), await b.json().then((x) => x.message));
});

test("logout revokes the issued token", async () => {
  const e = email("logout");
  const created = await json("POST", "/auth/signup", { email: e, password: PASSWORD, role: "client" });
  const { token } = await created.json();
  assert.equal(token.split(".").length, 3, "login returns a JWT");

  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${BASE}/auth/me`, { headers: auth })).status, 200);
  assert.equal((await json("POST", "/auth/logout", {}, auth)).status, 200);
  assert.equal((await fetch(`${BASE}/auth/me`, { headers: auth })).status, 401);
});

test("admin signup requires the configured setup secret", async () => {
  const payload = { username: `ops${suffix}`, password: PASSWORD };
  assert.equal((await json("POST", "/auth/admin-signup", payload)).status, 403);
  assert.equal(
    (await json("POST", "/auth/admin-signup", payload, { "x-admin-setup-secret": "wrong" })).status,
    403,
  );
  const ok = await json("POST", "/auth/admin-signup", payload, { "x-admin-setup-secret": "test-admin-secret" });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).user.role, "dev");
});

test("repeated failures lock the identifier out", async () => {
  let last = 0;
  for (let i = 0; i < 10; i++) {
    const r = await json("POST", "/auth/login", { username: `ghost-${suffix}`, password: "nope" });
    last = r.status;
    if (r.status === 429) break;
  }
  assert.equal(last, 429, "lockout eventually returns 429");
});

test("security headers are present", async () => {
  const res = await fetch(`${BASE}/meta/network`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.ok(res.headers.get("content-security-policy"));
  assert.equal(res.headers.get("x-powered-by"), null);
});
