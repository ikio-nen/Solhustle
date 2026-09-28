import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import * as web3 from "@solana/web3.js";
import { DatabaseSync } from "node:sqlite";

/**
 * The second rail: a UPI fraud report judged against the RBI's reporting clock.
 *
 * The point of this file is not "a second rulebook exists". It is that the engine
 * genuinely did not learn about UPI — the same case tables, the same arbiter, the
 * same precedent store, and a rail that disagrees with escrow about the two
 * things that matter: whether a remedy moves money, and what the clock measures.
 */

// --- stub provider ------------------------------------------------------------

let nextAnswer: Record<string, unknown> = { decision: "refer_to_bank", reasoning: "stub" };
const prompts: string[] = [];

const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try {
      const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
      const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
      prompts.push(user);
    } catch {
      /* record nothing rather than a lie */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(nextAnswer) } }] }));
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as net.AddressInfo).port;
after(() => stub.close());

const lastPrompt = () => prompts[prompts.length - 1]!;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-upi-"));
process.env.DATA_DIR = tmp;
process.env.KEYS_DIR = tmp;
process.env.SEED_DEMO_ACCOUNTS = "false";
process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/none";
process.env.LLM_API_KEY = "test-key";
process.env.LLM_BASE_URL = `http://127.0.0.1:${stubPort}/v1`;
process.env.LLM_MODEL = "stub-model";

const { db } = await import("../db.ts");
const { createCase, deadlineFor, getCase, liabilityBandFor } = await import("../cases.ts");
const { ruleCase, confirmCase, RULEBOOK_IDS } = await import("../arbiter.ts");
const { upiRulebook, UPI_REMEDIES, REFUND_REMEDY, BANK_REVIEW_REMEDY } = await import("../rulebooks/upi.ts");

// --- time helpers --------------------------------------------------------------
//
// Derived here rather than hardcoded, so the test does not quietly depend on which
// day of the week it happens to run.

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** UTC midnight N working days ago — the inverse of `addWorkingDays`. */
function workingDaysAgo(n: number, from: Date = new Date()): Date {
  const cursor = utcMidnight(from);
  let remaining = n;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return cursor;
}

const dbUtc = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

// --- fixtures ------------------------------------------------------------------

const OPERATOR = (() => {
  const kp = web3.Keypair.generate();
  const info = db
    .prepare("INSERT INTO users (wallet_address, role) VALUES (?, 'support')")
    .run(kp.publicKey.toBase58());
  return Number(info.lastInsertRowid);
})();

let caseSeq = 0;

/** A UPI report with a controlled transaction time and arrival time. */
function seedUpiCase(opts: {
  title: string;
  narrative: string;
  transactionWorkingDaysAgo: number | null;
  reportedWorkingDaysAgo?: number;
  amount?: number;
  partyRef?: string;
}): number {
  caseSeq += 1;
  const txAt = opts.transactionWorkingDaysAgo === null ? null : workingDaysAgo(opts.transactionWorkingDaysAgo);
  const created = createCase({
    rail: "upi",
    title: opts.title,
    partyRef: opts.partyRef ?? `UPI/2026/${caseSeq}`,
    amount: opts.amount ?? 4_999,
    currency: "INR",
    clockStartedAt: txAt ? dbUtc(txAt) : null,
    payload: {},
    evidence: [{ source: "report", kind: "text", body: opts.narrative }],
  });
  if (opts.reportedWorkingDaysAgo !== undefined) {
    // The report's arrival is the fact the RBI window measures, so the test has to
    // be able to move it independently of the transaction.
    db.prepare("UPDATE cases SET created_at = ? WHERE id = ?").run(
      dbUtc(workingDaysAgo(opts.reportedWorkingDaysAgo)),
      created.id,
    );
  }
  return created.id;
}

// --- the clock -----------------------------------------------------------------

test("liability follows when the report arrived, not when the case was ruled", async () => {
  // Reported the day after the transaction, then left in the queue for a week.
  // Read at ruling time the zero window would have closed days ago; the circular
  // turns on when the customer reported, so the band must not move with our backlog
  // — otherwise a slow queue silently becomes the customer's liability.
  const txAt = workingDaysAgo(6);
  const reportedAt = workingDaysAgo(5);
  const caseId = seedUpiCase({
    title: "Unauthorised debit for a gaming top-up in Pune",
    narrative: "A debit I did not make: 4999 INR to an unknown payee.",
    transactionWorkingDaysAgo: 6,
    reportedWorkingDaysAgo: 5,
  });

  assert.equal(liabilityBandFor(txAt, reportedAt), "zero", "reported one working day after the transaction");
  assert.equal(
    liabilityBandFor(txAt, new Date()),
    "limited",
    "the naive reading — the window as of today — has already moved on",
  );

  nextAnswer = { decision: BANK_REVIEW_REMEDY, reasoning: "Looking at the window." };
  const ruled = await ruleCase(caseId, { actorId: OPERATOR });
  assert.equal(ruled.liability.band, "zero", "the band is fixed at the moment of reporting");
  assert.equal(ruled.liability.signals.reported_working_days, 1);
  assert.match(ruled.liability.basis, /inside the RBI's 3-working-day window/);
  assert.match(ruled.liability.basis, /bears no liability for an unauthorised transfer/);
});

test("the clock is derived from the transaction time, not from the case row", async () => {
  // Independently of the rulebook, the case layer already knows how to band a
  // report; the rail must agree with it rather than invent a second opinion.
  const txAt = workingDaysAgo(1);
  const aDayLater = new Date(txAt.getTime() + 86_400_000);
  assert.equal(liabilityBandFor(txAt, aDayLater), "zero");
  assert.equal(liabilityBandFor(txAt, workdaysAfter(txAt, 5)), "limited");
  assert.equal(liabilityBandFor(txAt, workdaysAfter(txAt, 9)), "bank_policy");

  function workdaysAfter(from: Date, n: number): Date {
    const cursor = new Date(from);
    let remaining = n;
    while (remaining > 0) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) remaining--;
    }
    return cursor;
  }
});

test("a missing transaction time never opens the zero window", async () => {
  const caseId = seedUpiCase({
    title: "Debit I cannot date",
    narrative: "Money left my account at some point last week. I want it back.",
    transactionWorkingDaysAgo: null,
  });

  assert.equal(deadlineFor(getCase(caseId)!), null, "no transaction time means no RBI clock at all");
  assert.equal(upiRulebook.deadline(getCase(caseId)!), null);

  nextAnswer = { decision: REFUND_REMEDY, reasoning: "Refund it." };
  const ruled = await ruleCase(caseId, { actorId: OPERATOR });
  assert.equal(ruled.liability.band, "clock_unknown");
  assert.match(ruled.liability.basis, /must not be treated as open/);
  // The model was told the window is unknown rather than left to assume it is open.
  assert.match(lastPrompt(), /liability_band: clock_unknown/);
});

test("the UPI rail has a clock where escrow has none", () => {
  const withClock = seedUpiCase({
    title: "Reported promptly",
    narrative: "Reported the same day.",
    transactionWorkingDaysAgo: 1,
  });
  const deadline = upiRulebook.deadline(getCase(withClock)!);
  assert.ok(deadline, "a UPI report is governed by the RBI timeline");
  assert.match(deadline!.citation, /RBI circular/);
  assert.equal(deadline!.rail, "upi");
  assert.ok(deadline!.msRemaining > 0, "a one-day-old report is still inside the window");
});

// --- the remedies ---------------------------------------------------------------

test("no UPI remedy claims to move money", () => {
  for (const remedy of UPI_REMEDIES) {
    assert.equal(remedy.movesFunds, false, `${remedy.id} must not claim to move funds`);
    assert.match(remedy.effect, /nothing moves|no money moves|Nothing moves/i);
  }
});

test("confirming a UPI remedy records a finding and touches no money", async () => {
  const caseId = seedUpiCase({
    title: "Phishing debit at a fake merchant",
    narrative: "I was sent a collect request I did not authorise.",
    transactionWorkingDaysAgo: 1,
  });
  nextAnswer = { decision: REFUND_REMEDY, reasoning: "Unauthorised and reported in time." };
  const ruled = await ruleCase(caseId, { actorId: OPERATOR });
  assert.equal(ruled.ruling.decision, REFUND_REMEDY);

  const escrowBefore = (db.prepare("SELECT COUNT(*) AS n FROM escrow_transactions").get() as { n: number }).n;
  const jobsBefore = (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;

  const confirmed = await confirmCase(caseId, OPERATOR);
  const detail = (confirmed.outcome as { detail: { moved: boolean; note: string; liability_band: string | null } })
    .detail;

  assert.equal(detail.moved, false);
  assert.match(detail.note, /no funds were transferred by this system/i);
  assert.equal(detail.liability_band, "zero", "the receipt records the window it rested on");
  assert.equal(getCase(caseId)!.status, "confirmed");

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM escrow_transactions").get() as { n: number }).n,
    escrowBefore,
    "no escrow ledger row was written",
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
    jobsBefore,
    "and no contract was touched",
  );
});

test("a UPI case cannot be confirmed before it is ruled", async () => {
  const caseId = seedUpiCase({
    title: "Nothing ruled yet",
    narrative: "Please look at this.",
    transactionWorkingDaysAgo: 1,
  });
  await assert.rejects(() => confirmCase(caseId, OPERATOR), /no ruling to confirm/);
});

// --- the precedent store, on the second rail ------------------------------------

const SHARED = "collect request phishing merchant vpa";

test("a UPI ruling is offered to later UPI cases, with provenance", async () => {
  const first = seedUpiCase({
    title: `Unauthorised collect request ${SHARED}`,
    narrative: `A ${SHARED} I never approved.`,
    transactionWorkingDaysAgo: 1,
  });
  nextAnswer = {
    decision: REFUND_REMEDY,
    reasoning: `The ${SHARED} was never authorised by the customer.`,
    cited_ruling_ids: [],
  };
  const ruled1 = await ruleCase(first, { actorId: OPERATOR });

  const second = seedUpiCase({
    title: `Unauthorised collect request ${SHARED}`,
    narrative: `Another ${SHARED} I never approved.`,
    transactionWorkingDaysAgo: 2,
  });
  nextAnswer = { decision: REFUND_REMEDY, reasoning: "Same shape.", cited_ruling_ids: [ruled1.ruling.id] };
  const ruled2 = await ruleCase(second, { actorId: OPERATOR });

  assert.ok(
    ruled2.precedents.some((p) => p.id === ruled1.ruling.id),
    "the earlier UPI ruling was retrieved",
  );
  assert.deepEqual(ruled2.citations, [ruled1.ruling.id]);
  assert.equal(ruled2.precedents[0]!.rulebook, "upi_fraud_report");
  assert.equal(ruled2.precedents[0]!.caseId, first, "provenance points at the case it came from");
});

test("the precedent store keeps the rails apart in both directions", async () => {
  // An escrow ruling with identical vocabulary. If the rulebook filter were missing
  // it would be the closest match for the UPI case below and would be offered.
  const escrowCase = createCase({ rail: "escrow", title: `Dispute ${SHARED}`, payload: { job_id: 1 } });
  db.prepare(
    "INSERT INTO rulings (case_id, rulebook, decision, reasoning) VALUES (?, 'escrow_contract', 'hold_buyer', ?)",
  ).run(escrowCase.id, `unrelated escrow reasoning ${SHARED}`);
  const { indexRuling } = await import("../precedents.ts");
  indexRuling({
    rulingId: Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id),
    caseId: escrowCase.id,
    rulebook: "escrow_contract",
    decision: "hold_buyer",
    liabilityBand: "freelancer_delivered",
    reasoning: `unrelated escrow reasoning ${SHARED}`,
    evidence: [`escrow evidence ${SHARED}`],
  });

  const upiCase = seedUpiCase({
    title: `Unauthorised collect request ${SHARED}`,
    narrative: `A ${SHARED} I never approved.`,
    transactionWorkingDaysAgo: 1,
  });
  nextAnswer = { decision: BANK_REVIEW_REMEDY, reasoning: "Checking what is citable.", cited_ruling_ids: [] };
  const ruled = await ruleCase(upiCase, { actorId: OPERATOR });

  assert.ok(
    ruled.precedents.every((p) => p.rulebook === "upi_fraud_report"),
    "escrow rulings are never offered to a UPI case",
  );
});

// --- the HTTP surface ------------------------------------------------------------

const tmpHttp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-upi-http-"));
function freePort(): number {
  const srv = net.createServer();
  srv.listen(0);
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  return port;
}
const PORT = String(freePort());
const server = spawn(
  process.execPath,
  ["--experimental-strip-types", "--experimental-transform-types", "server/server.ts"],
  {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      PORT,
      DATA_DIR: tmpHttp,
      KEYS_DIR: tmpHttp,
      NODE_ENV: "development",
      JWT_SECRET: "test-secret-value-for-upi-tests",
      ADMIN_SETUP_SECRET: "test-admin-secret",
      SEED_DEMO_ACCOUNTS: "false",
      DATABASE_URL: "postgresql://user:pass@127.0.0.1:1/none",
      LLM_API_KEY: "test-key",
      LLM_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      LLM_MODEL: "stub-model",
    },
  },
);
server.stderr.on("data", (d) => {
  const s = String(d);
  if (!/Neon|SSL|ExperimentalWarning|trace-warnings|libpq/.test(s)) process.stderr.write(s);
});
after(async () => {
  server.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 400));
  try {
    fs.rmSync(tmpHttp, { recursive: true, force: true });
  } catch {
    /* best-effort on Windows */
  }
});
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/meta/network`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}

test("a UPI report is opened, ruled and confirmed through the HTTP surface", { timeout: 120_000 }, async () => {
  await waitForServer();

  await fetch(`${BASE}/auth/admin-signup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-setup-secret": "test-admin-secret" },
    body: JSON.stringify({ username: "upiop", password: "Str0ng-Pass!" }),
  });
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "upiop", password: "Str0ng-Pass!" }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const token = ((await login.json()) as { token: string }).token;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const sideDb = new DatabaseSync(path.join(tmpHttp, "app.db"));
  const txAt = workingDaysAgo(2);

  const created = await fetch(`${BASE}/arbiter/cases`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      rail: "upi",
      title: "Unauthorised debit to an unknown VPA",
      party_ref: "UPI/2026/HTTP-1",
      amount: 12_500,
      currency: "INR",
      clock_started_at: dbUtc(txAt),
      narrative:
        "Someone sent a collect request to my phone and my balance of 12500 INR left the account. I did not approve it.",
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = (await created.json()) as {
    case: { id: number; rail: string };
    deadline: { liabilityBand: string; citation: string } | null;
  };
  assert.equal(createdBody.case.rail, "upi");
  assert.equal(createdBody.deadline?.liabilityBand, "zero", "two working days is inside the window");
  assert.match(createdBody.deadline!.citation, /RBI/);
  const caseId = createdBody.case.id;

  nextAnswer = { decision: REFUND_REMEDY, reasoning: "Unauthorised and reported inside the window.", cited_ruling_ids: [] };
  const before = prompts.length;
  const ruled = await fetch(`${BASE}/arbiter/cases/${caseId}/rule`, { method: "POST", headers: auth, body: "{}" });
  assert.equal(ruled.status, 200, await ruled.clone().text());
  const ruledBody = (await ruled.json()) as {
    ruling: { id: number; decision: string; liability_band: string; rulebook: string };
    suspicious: boolean;
    quarantinedRefs: string[];
    liability: { band: string };
  };
  assert.equal(prompts.length, before + 1, "the stub was actually asked");
  assert.equal(ruledBody.ruling.rulebook, "upi_fraud_report");
  assert.equal(ruledBody.ruling.decision, REFUND_REMEDY);
  assert.equal(ruledBody.ruling.liability_band, "zero");
  assert.equal(ruledBody.suspicious, false);

  // The rail's own clock and framing reached the model, and the evidence did too —
  // as delimited data, exactly as on the escrow rail.
  const prompt = lastPrompt();
  assert.match(prompt, /GOVERNING CLOCK/);
  assert.match(prompt, /RBI circular/);
  assert.match(prompt, /<<<EVIDENCE/);
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /12500 INR/);
  assert.match(prompt, /someone sent a collect request/i);

  const confirmed = await fetch(`${BASE}/arbiter/cases/${caseId}/confirm`, { method: "POST", headers: auth, body: "{}" });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const confirmedBody = (await confirmed.json()) as {
    remedy: { id: string; movesFunds: boolean };
    outcome: { detail: { moved: boolean; note: string } };
    case: { status: string };
  };
  assert.equal(confirmedBody.remedy.id, REFUND_REMEDY);
  assert.equal(confirmedBody.remedy.movesFunds, false);
  assert.equal(confirmedBody.outcome.detail.moved, false, "the receipt must not claim money moved");
  assert.equal(confirmedBody.case.status, "confirmed");

  // Nothing on-chain was written for a rail that has no on-chain leg.
  assert.equal(
    (sideDb.prepare("SELECT COUNT(*) AS n FROM escrow_transactions").get() as { n: number }).n,
    0,
    "a UPI confirmation writes no escrow transaction",
  );

  // The console reads a ruled case back through one call.
  const list = await fetch(`${BASE}/arbiter/cases/${caseId}/rulings`, { headers: auth });
  assert.equal(list.status, 200, await list.clone().text());
  const listBody = (await list.json()) as {
    rulings: { id: number; decision: string; cited_precedents: unknown[] }[];
    quarantined_evidence: unknown[];
  };
  assert.equal(listBody.rulings.length, 1);
  assert.equal(listBody.rulings[0]!.id, ruledBody.ruling.id);
  assert.equal(listBody.rulings[0]!.decision, REFUND_REMEDY);
  assert.deepEqual(listBody.rulings[0]!.cited_precedents, []);
  assert.deepEqual(listBody.quarantined_evidence, []);

  sideDb.close();
});

test("the rulebook registry has an entry per rail the case layer accepts", () => {
  // Guards the actual failure mode of a second rail: a case created on a rail the
  // arbiter has no rulebook for, which only surfaces when someone tries to rule it.
  assert.deepEqual([...RULEBOOK_IDS].sort(), ["escrow", "upi"]);
});
