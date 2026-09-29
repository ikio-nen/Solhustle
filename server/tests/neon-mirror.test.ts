import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

/**
 * The Postgres mirror, tested where it is dangerous.
 *
 * Two conversions in `neon.ts` are silent when they are wrong: a zone-less SQLite
 * timestamp written to a `timestamptz` column lands shifted with nothing raised,
 * and an unparseable JSONB payload takes a whole 500-row batch down with it. Both
 * are pinned here, against the exact strings SQLite produces.
 *
 * Everything else asserted here is the degradation contract: this mirror is
 * best-effort by design, so a mirror that is unreachable has to cost the caller
 * nothing — no throw on the write path, no 500 on the status view that exists to
 * report the outage. The endpoint below is a dead local port, which is the only
 * way to make "configured but unreachable" happen without a network dependency.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-neon-"));
process.env.DATA_DIR = tmp;
process.env.KEYS_DIR = tmp;
process.env.SEED_DEMO_ACCOUNTS = "false";
// Configured, and pointed at nothing. Port 1 is never listening, so every query
// fails the way a firewalled or stopped Postgres would.
const DEAD_URL = "postgresql://user:pass@127.0.0.1:1/none";
process.env.DATABASE_URL = DEAD_URL;

const { neonConfigured, toUtcIso, jsonOrEmpty, syncCaseGraphToNeon, syncAllUsersToNeon, getCaseLawFromNeon } =
  await import("../neon.ts");
const { createCase, getCaseDetail, updateCase } = await import("../cases.ts");

// --- the two silent conversions -------------------------------------------------

test("toUtcIso stamps the zone SQLite leaves off", () => {
  // This is the shape `datetime('now')` returns, and the exact case the mirror
  // used to write wrong: the same wall clock on every row, read as the endpoint's
  // local time.
  assert.equal(toUtcIso("2026-09-29 04:11:07"), "2026-09-29T04:11:07Z");
  assert.equal(toUtcIso("2026-09-29T04:11:07"), "2026-09-29T04:11:07Z");
  // Sub-second precision survives; timestamps carry it and a deadline does not
  // want to lose it.
  assert.equal(toUtcIso("2026-09-29 04:11:07.123"), "2026-09-29T04:11:07.123Z");
  // Already-qualified values keep their zone rather than being restamped.
  assert.equal(toUtcIso("2026-09-29T04:11:07+05:30"), "2026-09-28T22:41:07.000Z");
  assert.equal(toUtcIso(new Date("2026-09-29T04:11:07Z")), "2026-09-29T04:11:07.000Z");
  // Nothing is invented for a value that is not a time.
  assert.equal(toUtcIso(null), null);
  assert.equal(toUtcIso(undefined), null);
  assert.equal(toUtcIso(""), null);
  assert.equal(toUtcIso("   "), null);
  assert.equal(toUtcIso("not a date"), null);
  assert.equal(toUtcIso(new Date("nonsense")), null);

  // The point of the whole function, stated as an instant so it cannot pass by
  // accident on a host whose timezone happens to be UTC: 04:11:07 on the 29th is
  // that instant, not the instant the host reads it as.
  assert.equal(new Date(toUtcIso("2026-09-29 04:11:07")!).getTime(), Date.UTC(2026, 8, 29, 4, 11, 7));
});

test("jsonOrEmpty keeps a valid payload and defuses a corrupt one", () => {
  assert.equal(jsonOrEmpty('{"txn":"X1","amount":48000}'), '{"txn":"X1","amount":48000}');
  // An array is valid JSONB too; the guard is about parseability, not shape.
  assert.equal(jsonOrEmpty("[1,2]"), "[1,2]");
  assert.equal(jsonOrEmpty("null"), "null");
  // A partial write from an interrupted request must not poison its whole batch.
  assert.equal(jsonOrEmpty('{"txn":'), "{}");
  assert.equal(jsonOrEmpty(""), "{}");
  assert.equal(jsonOrEmpty("   "), "{}");
  assert.equal(jsonOrEmpty(null), "{}");
  assert.equal(jsonOrEmpty(undefined), "{}");
  // A value that is already an object is not this function's input.
  assert.equal(jsonOrEmpty({ a: 1 }), "{}");
});

// --- the degradation contract ---------------------------------------------------

test("this file really is testing the configured-but-unreachable path", () => {
  // If this ever becomes false the rest of the file would be asserting the inert
  // path, which is a different (and easier) contract.
  assert.equal(neonConfigured, true);
  assert.equal(process.env.DATABASE_URL, DEAD_URL);
});

test("a mirror that cannot be reached never throws at its callers", async () => {
  // An id that does not exist returns before any connection is attempted.
  assert.equal(await syncCaseGraphToNeon(4242), 0);

  // A real case, on a real database, with an endpoint that is not there.
  const created = createCase({
    rail: "upi",
    title: "collect-request fraud",
    amount: 48000,
    currency: "INR",
    clockStartedAt: "2026-10-09T00:00:00Z",
    evidence: [{ kind: "text", body: "Approve this request to receive 48000." }],
  });
  assert.ok(created.id > 0);

  // The hook the case layer fires is fire-and-forget for exactly this reason.
  assert.equal(await syncCaseGraphToNeon(created.id), 0);
  // And the batch entry points answer a count rather than rejecting.
  assert.equal(await syncAllUsersToNeon(), 0);

  // The write that was attempted is still whole locally: a mirror outage is not
  // allowed to cost the person waiting on the ruling their case.
  const detail = getCaseDetail(created.id)!;
  assert.equal(detail.evidence.length, 1);
  assert.match(detail.evidence[0]!.body, /48000/);
  updateCase(created.id, { status: "open" });
  assert.equal(getCaseDetail(created.id)?.case.status, "open");
});

test("the readers themselves reject; the route is where the outage is absorbed", async () => {
  // Worth stating explicitly, because it is the boundary of the degradation: the
  // mirror's writers swallow their failure, its readers do not, and the status
  // route above is the thing that turns a reader's rejection into a report.
  await assert.rejects(getCaseLawFromNeon());
});

// --- the status view ------------------------------------------------------------

function findFreePortSync(): number {
  const srv = net.createServer();
  srv.listen(0);
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  return port;
}

const serverTmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-neon-http-"));
const PORT = String(findFreePortSync());
const server = spawn(
  process.execPath,
  ["--experimental-strip-types", "--experimental-transform-types", "server/server.ts"],
  {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      PORT,
      DATA_DIR: serverTmp,
      KEYS_DIR: serverTmp,
      NODE_ENV: "development",
      JWT_SECRET: "test-secret-value-for-neon-tests",
      ADMIN_SETUP_SECRET: "test-admin-secret",
      SEED_DEMO_ACCOUNTS: "false",
      DATABASE_URL: DEAD_URL,
      LLM_API_KEY: "",
    },
  },
);
server.stderr.on("data", (d) => {
  // The boot sync's failure against the dead endpoint is the expected path here.
  const s = String(d);
  if (!/Neon|SSL|ExperimentalWarning|trace-warnings|libpq/.test(s)) process.stderr.write(s);
});

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

function json(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("the mirror status view is staff-only and survives an unreachable mirror", { timeout: 60_000 }, async (t) => {
  await waitForServer();
  t.after(async () => {
    server.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 400));
    try {
      fs.rmSync(serverTmp, { recursive: true, force: true });
    } catch {
      /* best-effort; the OS reclaims the temp directory regardless */
    }
  });

  await t.test("anonymous callers get 401", async () => {
    // This route hands out every wallet address and settled transaction, so it is
    // the same material /admin/users gates — it was an unauthenticated way around it.
    assert.equal((await json("GET", "/neon/status")).status, 401);
  });

  await t.test("staff get the outage, not a 500", async () => {
    const signup = await json(
      "POST",
      "/auth/admin-signup",
      { username: "mirrorops", password: "Str0ng-Pass!" },
      { "x-admin-setup-secret": "test-admin-secret" },
    );
    assert.equal(signup.status, 201, JSON.stringify(await signup.clone().json()));
    const login = await json("POST", "/auth/login", { username: "mirrorops", password: "Str0ng-Pass!" });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };

    const res = await json("GET", "/neon/status", undefined, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 200, "an unreachable mirror is the page's subject, not its failure");
    const body = (await res.json()) as any;

    // Configured, so the app is honest that a mirror is expected — with the reason
    // it could not be read, and no counts invented from rows nobody fetched.
    assert.equal(body.connected, true);
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0, "the outage is reported, not swallowed");
    assert.deepEqual(body.counts, {
      users: 0,
      jobs: 0,
      settled_transactions: 0,
      cases: 0,
      rulings: 0,
      citations: 0,
    });
    assert.deepEqual(body.case_law, []);
    assert.deepEqual(body.users, []);
  });
});
