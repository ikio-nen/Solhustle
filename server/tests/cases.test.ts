import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

/**
 * The case layer: the working-day maths the RBI timeline depends on, the CRUD
 * round-trip, and — through a real server — the HTTP wiring and its staff gate.
 *
 * The maths is asserted against the October 2026 calendar, which is a convenient
 * fixture because the hackathon weekend (10–11 Oct) sits between two working
 * weeks: a naive `+3 days` implementation lands on a Sunday and fails here.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-cases-"));
process.env.DATA_DIR = tmp;
process.env.KEYS_DIR = tmp;
process.env.SEED_DEMO_ACCOUNTS = "false";
process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/none";

const { db } = await import("../db.ts");
const {
  addWorkingDays,
  workingDaysElapsed,
  liabilityBandFor,
  deadlineFor,
  normalizeUtc,
  createCase,
  getCase,
  listCases,
  updateCase,
  deleteCase,
  addEvidence,
  listEvidenceForCase,
  getCaseDetail,
} = await import("../cases.ts");

const day = (v: Date | string) => new Date(v).toISOString().slice(0, 10);

test("addWorkingDays skips weekends", () => {
  // Friday 9 Oct → the next working day is Monday the 12th, not Saturday.
  assert.equal(day(addWorkingDays(new Date("2026-10-09T00:00:00Z"), 1)), "2026-10-12");
  // Three working days from Friday crosses the weekend: Mon, Tue, Wed.
  assert.equal(day(addWorkingDays(new Date("2026-10-09T00:00:00Z"), 3)), "2026-10-14");
  assert.equal(day(addWorkingDays(new Date("2026-10-05T00:00:00Z"), 3)), "2026-10-08");
  // Zero days is the same date, even when that date is a Saturday.
  assert.equal(day(addWorkingDays(new Date("2026-10-10T00:00:00Z"), 0)), "2026-10-10");
  assert.throws(() => addWorkingDays(new Date(), -1));
});

test("workingDaysElapsed counts only Monday–Friday in (from, to]", () => {
  assert.equal(workingDaysElapsed(new Date("2026-10-09T00:00:00Z"), new Date("2026-10-09T00:00:00Z")), 0);
  assert.equal(workingDaysElapsed(new Date("2026-10-09T00:00:00Z"), new Date("2026-10-12T00:00:00Z")), 1);
  // A whole weekend adds nothing.
  assert.equal(workingDaysElapsed(new Date("2026-10-09T00:00:00Z"), new Date("2026-10-11T00:00:00Z")), 0);
  assert.equal(workingDaysElapsed(new Date("2026-10-05T00:00:00Z"), new Date("2026-10-09T00:00:00Z")), 4);
  assert.equal(workingDaysElapsed(new Date("2026-10-09T00:00:00Z"), new Date("2026-10-19T00:00:00Z")), 6);
  // A backwards range is not negative experience.
  assert.equal(workingDaysElapsed(new Date("2026-10-19T00:00:00Z"), new Date("2026-10-09T00:00:00Z")), 0);
});

test("liability bands track the RBI timeline", () => {
  const clock = new Date("2026-10-09T00:00:00Z");
  assert.equal(liabilityBandFor(clock, new Date("2026-10-12T00:00:00Z")), "zero"); // 1
  assert.equal(liabilityBandFor(clock, new Date("2026-10-15T00:00:00Z")), "limited"); // 4
  assert.equal(liabilityBandFor(clock, new Date("2026-10-20T00:00:00Z")), "limited"); // 7
  assert.equal(liabilityBandFor(clock, new Date("2026-10-21T00:00:00Z")), "bank_policy"); // 8
});

test("a DB timestamp without a zone is read as UTC, not as host-local time", () => {
  // This is the trap the whole layer is written around: `new Date` would read
  // "2026-10-09 12:00:00" as local time and move every deadline by the offset.
  assert.equal(normalizeUtc("2026-10-09 12:00:00"), "2026-10-09 12:00:00");
  const fromDbForm = deadlineFor(
    { rail: "upi", clock_started_at: "2026-10-09 12:00:00" },
    new Date("2026-10-12T09:00:00Z"),
  );
  const fromIsoForm = deadlineFor(
    { rail: "upi", clock_started_at: "2026-10-09T12:00:00Z" },
    new Date("2026-10-12T09:00:00Z"),
  );
  assert.ok(fromDbForm && fromIsoForm);
  assert.equal(fromDbForm.dueAt, fromIsoForm.dueAt);
});

test("the zero-liability window closes at the end of the third working day", () => {
  const d = deadlineFor(
    { rail: "upi", clock_started_at: "2026-10-09T12:00:00Z" },
    new Date("2026-10-12T09:00:00Z"),
  );
  assert.ok(d, "the UPI rail has a statutory clock");
  assert.equal(d.dueAt, "2026-10-14T23:59:59.999Z");
  assert.equal(d.limitedUntil, "2026-10-20T23:59:59.999Z");
  assert.equal(d.liabilityBand, "zero");
  assert.equal(d.expired, false);
  // Tue 13th and Wed 14th are still ahead of a Monday-morning "now".
  assert.equal(d.workingDaysRemaining, 2);
  assert.ok(d.msRemaining > 0);
  assert.match(d.citation, /2017-18/);
  assert.ok(d.notes.some((n) => /bank holidays are not modelled/.test(n)));
});

test("a missed window stays honest about it", () => {
  const d = deadlineFor(
    { rail: "upi", clock_started_at: "2026-09-01T10:00:00Z" },
    new Date("2026-10-01T10:00:00Z"),
  );
  assert.ok(d);
  assert.equal(d.expired, true);
  assert.equal(d.liabilityBand, "bank_policy");
  assert.equal(d.workingDaysRemaining, 0);
  assert.ok(d.msRemaining < 0);
});

test("rails with no statutory clock report no deadline rather than a guess", () => {
  assert.equal(deadlineFor({ rail: "escrow", clock_started_at: "2026-10-09T12:00:00Z" }), null);
  assert.equal(deadlineFor({ rail: "upi", clock_started_at: null }), null);
});

test("case CRUD round-trips", () => {
  const created = createCase({
    rail: "upi",
    title: "Fake collect request",
    partyRef: "victim@upi",
    amount: 48000,
    currency: "INR",
    clockStartedAt: "2026-10-09T12:00:00Z",
    payload: { channel: "whatsapp" },
    evidence: [{ source: "victim", kind: "text", body: "They asked me to approve a request to receive money." }],
  });

  assert.equal(created.rail, "upi");
  assert.equal(created.status, "open");
  // The stored clock is normalised to the DB's UTC text form.
  assert.equal(created.clock_started_at, "2026-10-09 12:00:00");
  assert.deepEqual(JSON.parse(created.payload_json), { channel: "whatsapp" });

  assert.equal(listEvidenceForCase(created.id).length, 1);
  const added = addEvidence(created.id, { source: "bank", kind: "chain", body: "UTR 123", ref: "utr:123" });
  assert.equal(added.kind, "chain");
  assert.equal(listEvidenceForCase(created.id).length, 2);

  const escrow = createCase({ rail: "escrow", title: "Disputed design contract" });
  assert.equal(listCases({ rail: "upi" }).length, 1);
  assert.equal(listCases().length, 2);
  assert.equal(listCases({ status: "confirmed" }).length, 0);

  const updated = updateCase(created.id, { status: "ruled", payload: { channel: "whatsapp", reviewed: true } });
  assert.equal(updated?.status, "ruled");
  assert.equal(JSON.parse(updated!.payload_json).reviewed, true);
  assert.ok(updated!.updated_at);

  const detail = getCaseDetail(created.id);
  assert.ok(detail);
  assert.equal(detail.case.id, created.id);
  assert.equal(detail.evidence.length, 2);
  assert.equal(detail.deadline?.rail, "upi");
  // The escrow rail has nothing to count down.
  assert.equal(getCaseDetail(escrow.id)?.deadline, null);

  assert.equal(deleteCase(created.id), true);
  assert.equal(getCase(created.id), undefined);
  assert.equal(listEvidenceForCase(created.id).length, 0, "evidence goes with the case");
});

test("a case carrying precedents cannot be deleted", () => {
  const c = createCase({ rail: "upi", title: "Ruled case" });
  db.prepare("INSERT INTO rulings (case_id, rulebook, decision) VALUES (?, ?, ?)").run(c.id, "upi_rbi", "hold");
  assert.throws(() => deleteCase(c.id), /cannot be deleted/);
  assert.ok(getCase(c.id), "the case survives the refusal");
});

// --- HTTP wiring ---------------------------------------------------------------

function findFreePortSync(): number {
  const srv = net.createServer();
  srv.listen(0);
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  return port;
}

const serverTmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-cases-http-"));
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
      JWT_SECRET: "test-secret-value-for-case-tests",
      ADMIN_SETUP_SECRET: "test-admin-secret",
      SEED_DEMO_ACCOUNTS: "false",
      DATABASE_URL: "postgresql://user:pass@127.0.0.1:1/none",
      // No LLM provider on purpose: intake must still work, recording that it
      // could not structure the narrative rather than inventing fields.
      LLM_API_KEY: "",
    },
  },
);
server.stderr.on("data", (d) => {
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

test("cases are wired to HTTP behind the staff gate", { timeout: 60_000 }, async (t) => {
  await waitForServer();
  t.after(async () => {
    server.kill("SIGKILL");
    // Windows keeps the child's SQLite handles locked for a moment after the
    // process is signalled, so cleanup is best-effort — the OS reclaims the
    // temp directory regardless.
    await new Promise((r) => setTimeout(r, 400));
    try {
      fs.rmSync(serverTmp, { recursive: true, force: true });
    } catch {
      /* best-effort; nothing depends on removing it */
    }
  });

  await t.test("anonymous callers get 401", async () => {
    assert.equal((await json("GET", "/arbiter/cases")).status, 401);
    assert.equal((await json("POST", "/arbiter/cases", { rail: "upi", title: "x" })).status, 401);
  });

  await t.test("a staff session can open a case and read its deadline", async () => {
    const signup = await json(
      "POST",
      "/auth/admin-signup",
      { username: "caseops", password: "Str0ng-Pass!" },
      { "x-admin-setup-secret": "test-admin-secret" },
    );
    assert.equal(signup.status, 201, JSON.stringify(await signup.clone().json()));
    const login = await json("POST", "/auth/login", { username: "caseops", password: "Str0ng-Pass!" });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    const created = await json(
      "POST",
      "/arbiter/cases",
      {
        rail: "upi",
        title: "UPI collect-request fraud",
        amount: 48000,
        currency: "INR",
        narrative: "Someone sent me a request and said I had to approve it to receive 48000 rupees.",
      },
      auth,
    );
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const body = (await created.json()) as any;
    assert.equal(body.case.rail, "upi");
    // No provider is configured, so nothing was structured — and nothing was made up.
    assert.equal(body.extraction, "unavailable");
    assert.equal(body.case.clock_started_at, null, "no transaction date was invented");
    assert.equal(body.deadline, null, "and therefore no countdown was invented either");
    assert.equal(body.case.payload_json, "{}", "payload records no structured fields");

    // The pasted report is still preserved as evidence.
    const detail = await json("GET", `/arbiter/cases/${body.case.id}`, undefined, auth);
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as any;
    assert.equal(detailBody.evidence.length, 1);
    assert.match(detailBody.evidence[0].body, /48000 rupees/);

    // Supplying the date explicitly is what starts the clock.
    const dated = await json(
      "PATCH",
      `/arbiter/cases/${body.case.id}`,
      { clock_started_at: "2026-10-09" },
      auth,
    );
    assert.equal(dated.status, 200);
    const datedBody = (await dated.json()) as any;
    assert.equal(datedBody.deadline.dueAt, "2026-10-14T23:59:59.999Z");

    const list = await json("GET", "/arbiter/cases?rail=upi", undefined, auth);
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as any).cases.length, 1);

    // Bad input is rejected before it can reach the tables.
    const invalid = await json("POST", "/arbiter/cases", { rail: "nope", title: "x" }, auth);
    assert.equal(invalid.status, 400);
  });
});
