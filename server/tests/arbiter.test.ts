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
 * The arbiter, end to end and offline.
 *
 * The model is a local stub, so these tests say exactly what the provider said
 * and assert on what the engine did with it. Chain touches are avoided on
 * purpose: the release path is driven through the *idempotent replay* branch of
 * `escrow.releaseEscrow` (and, for the refusal case, through a precondition that
 * fails before any network call), so the whole file runs with no RPC and no
 * faucet — while still proving the arbiter delegates to the real escrow module
 * rather than moving money itself.
 */

// --- stub provider -------------------------------------------------------------

let nextRuling: Record<string, unknown> = { decision: "hold_buyer", reasoning: "stub", cited_ruling_ids: [] };
let providerCalls = 0;
const stub = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    providerCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(nextRuling) } }] }));
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as net.AddressInfo).port;
after(() => stub.close());

// --- phase 1: module level -----------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-arbiter-"));
process.env.DATA_DIR = tmp;
process.env.KEYS_DIR = tmp;
process.env.SEED_DEMO_ACCOUNTS = "false";
process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/none";
process.env.LLM_API_KEY = "test-key";
process.env.LLM_BASE_URL = `http://127.0.0.1:${stubPort}/v1`;
process.env.LLM_MODEL = "stub-model";

const { db } = await import("../db.ts");
const { createCase, getCase } = await import("../cases.ts");
const { ruleCase, confirmCase, getRuling, listCitations } = await import("../arbiter.ts");
const { disputeEvidence } = await import("../disputes.ts");

function seedUser(role: string): number {
  // A fresh keypair each time: `users.wallet_address` is unique, and the demo
  // paths read it, so it should be a real address rather than a made-up label.
  const kp = web3.Keypair.generate();
  const info = db.prepare("INSERT INTO users (wallet_address, role) VALUES (?, ?)").run(kp.publicKey.toBase58(), role);
  return Number(info.lastInsertRowid);
}

const count = (sql: string, param?: number | string): number => {
  const row = (param === undefined ? db.prepare(sql).get() : db.prepare(sql).get(param)) as { n: number | bigint };
  return Number(row.n);
};

const OPERATOR = seedUser("support");

type Seeded = { jobId: number; disputeId: number; ticketId: number; caseId: number; freelancer: number };

/** A disputed, delivery-backed contract — the shape the escrow rail rules on. */
function seedDisputedCase(opts: { escrowAddress?: string | null; solLamports?: number | null; releaseTx?: string }): Seeded {
  const buyer = seedUser("client");
  const freelancer = seedUser("freelancer");
  const escrowAddress = opts.escrowAddress === undefined ? web3.Keypair.generate().publicKey.toBase58() : opts.escrowAddress;
  const info = db
    .prepare(
      `INSERT INTO jobs (buyer_id, freelancer_id, title, requirements, usd_budget, sol_lamports, status, escrow_address)
       VALUES (?, ?, ?, ?, ?, ?, 'disputed', ?)`,
    )
    .run(buyer, freelancer, "Brand refresh: logo + social kit", "New logo, 5 social templates, brand one-pager.", 80, opts.solLamports ?? null, escrowAddress);
  const jobId = Number(info.lastInsertRowid);

  db.prepare("INSERT INTO deliveries (job_id, version, note, attachment_urls, submitted_by) VALUES (?, 1, ?, ?, ?)").run(
    jobId,
    "v1: logo + templates",
    JSON.stringify(["https://drive.example.com/brand_v1.zip"]),
    freelancer,
  );
  db.prepare("INSERT INTO negotiations (job_id, offer_by, price_sol, scope) VALUES (?, ?, ?, ?)").run(
    jobId,
    freelancer,
    0.05,
    "logo + 5 templates",
  );
  db.prepare("INSERT INTO messages (job_id, sender_id, body) VALUES (?, ?, ?)").run(
    jobId,
    buyer,
    "The colours are off-brief and the one-pager is missing.",
  );
  const dispute = db
    .prepare("INSERT INTO disputes (job_id, raised_by, reason) VALUES (?, ?, ?)")
    .run(jobId, freelancer, "Work followed the brief; the rejection was unreasonable.");
  const disputeId = Number(dispute.lastInsertRowid);
  const ticket = db
    .prepare("INSERT INTO helpdesk_tickets (user_id, job_id, dispute_id, subject) VALUES (?, ?, ?, ?)")
    .run(freelancer, jobId, disputeId, `Dispute #${disputeId}: job #${jobId}`);
  if (opts.releaseTx) {
    db.prepare(
      "INSERT INTO escrow_transactions (job_id, tx_signature, instruction_type, amount_lamports) VALUES (?, ?, 'release', ?)",
    ).run(jobId, opts.releaseTx, opts.solLamports ?? 0);
  }
  const c = createCase({ rail: "escrow", title: `Dispute on job #${jobId}`, payload: { job_id: jobId } });
  return { jobId, disputeId, ticketId: Number(ticket.lastInsertRowid), caseId: c.id, freelancer };
}

const jobStatus = (jobId: number) =>
  (db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status;
const disputeStatus = (id: number) =>
  (db.prepare("SELECT status FROM disputes WHERE id = ?").get(id) as { status: string }).status;
const caseStatus = (id: number) => getCase(id)!.status;

test("a ruling is a recommendation: nothing moves until it is confirmed", async () => {
  const s = seedDisputedCase({ solLamports: 50_000_000 });
  nextRuling = { decision: "release_freelancer", reasoning: "Delivery exists and the rejection cites no requirement breach.", cited_ruling_ids: [] };

  const result = await ruleCase(s.caseId, { actorId: OPERATOR });

  assert.equal(result.ruling.decision, "release_freelancer");
  assert.equal(result.ruling.rulebook, "escrow_contract");
  assert.equal(result.ruling.model, "stub-model");
  assert.equal(result.ruling.cached, 0);
  assert.equal(result.ruling.liability_band, "freelancer_delivered");
  assert.equal(result.ruling.deadline_at, null, "the escrow rail has no statutory clock");
  assert.match(result.ruling.reasoning, /Delivery exists/);
  assert.equal(caseStatus(s.caseId), "ruled");

  // The whole point: the money has not moved and no status was touched.
  assert.equal(jobStatus(s.jobId), "disputed");
  assert.equal(disputeStatus(s.disputeId), "open");
  assert.equal(count("SELECT COUNT(*) AS n FROM escrow_transactions WHERE job_id = ?", s.jobId), 0);
  const audited = db
    .prepare("SELECT after_state FROM admin_actions WHERE action_type = 'case_ruled' AND target_id = ?")
    .get(s.caseId) as { after_state: string } | undefined;
  assert.ok(audited, "ruling is auditable");
  assert.match(audited.after_state, /release_freelancer/);
});

test("the evidence bundle is the same one the support console reads", async () => {
  const s = seedDisputedCase({ solLamports: 12_000_000 });
  const ev = await disputeEvidence(s.jobId);
  assert.equal(ev.job.id, s.jobId);

  const { escrowRulebook } = await import("../rulebooks/escrow.ts");
  const bundle = await escrowRulebook.gatherEvidence(getCase(s.caseId)!);
  const ids = bundle.items.map((i) => i.id);
  assert.ok(ids.some((id) => id.startsWith("delivery:")), "the delivery is evidence");
  assert.ok(ids.some((id) => id.startsWith("message:")), "the thread is evidence");
  assert.ok(ids.some((id) => id.startsWith("negotiation:")), "the negotiation is evidence");
  assert.ok(ids.some((id) => id.startsWith("dispute:")), "the dispute reason is evidence");
  assert.equal(bundle.context.job_status, "disputed");
  assert.equal(bundle.context.deliveries, 1);
  assert.equal(escrowRulebook.liability(bundle).band, "freelancer_delivered");
});

test("confirming a hold keeps the funds in escrow and detaches the freelancer", async () => {
  const s = seedDisputedCase({ solLamports: 75_000_000 });
  nextRuling = { decision: "hold_buyer", reasoning: "The rejection names requirements the delivery does not meet.", cited_ruling_ids: [] };

  await ruleCase(s.caseId, { actorId: OPERATOR });
  assert.equal(jobStatus(s.jobId), "disputed");

  const confirmed = await confirmCase(s.caseId, OPERATOR);
  assert.equal(confirmed.remedy.id, "hold_buyer");
  assert.equal(confirmed.remedy.movesFunds, false);

  const job = db.prepare("SELECT status, freelancer_id, escrow_address FROM jobs WHERE id = ?").get(s.jobId) as {
    status: string;
    freelancer_id: number | null;
    escrow_address: string;
  };
  assert.equal(job.status, "held_detached");
  assert.equal(job.freelancer_id, null, "the freelancer is detached so the round can be re-listed");
  assert.ok(job.escrow_address, "the vault still holds the contract");
  assert.equal(
    count("SELECT COUNT(*) AS n FROM escrow_transactions WHERE job_id = ?", s.jobId),
    0,
    "holding transfers nothing",
  );
  assert.equal(caseStatus(s.caseId), "confirmed");
  // The support queue and the case view must not disagree about one job.
  assert.equal(disputeStatus(s.disputeId), "ruled");
  assert.equal(
    (db.prepare("SELECT status FROM helpdesk_tickets WHERE id = ?").get(s.ticketId) as { status: string }).status,
    "resolved",
  );
});

test("confirming a release goes through escrow.releaseEscrow", async () => {
  // Seeding the release row puts `releaseEscrow` on its idempotent branch, so the
  // assertion below is about *delegation*: the signature the escrow module
  // returns is the one already on the ledger.
  const s = seedDisputedCase({ solLamports: 90_000_000, releaseTx: "seedSignatureRelease" });
  nextRuling = { decision: "release_freelancer", reasoning: "Delivered and accepted in substance.", cited_ruling_ids: [] };

  await ruleCase(s.caseId, { actorId: OPERATOR });
  const confirmed = await confirmCase(s.caseId, OPERATOR);

  const detail = confirmed.outcome as { remedy: string; applied: boolean; detail: { signature: string; alreadyRecorded: boolean; payoutLamports: number } };
  assert.equal(detail.applied, true);
  assert.equal(detail.detail.signature, "seedSignatureRelease");
  assert.equal(detail.detail.alreadyRecorded, true);
  assert.equal(jobStatus(s.jobId), "released");
  assert.equal(caseStatus(s.caseId), "confirmed");

  const auditRow = db
    .prepare("SELECT after_state FROM admin_actions WHERE action_type = 'case_confirmed' AND target_id = ?")
    .get(s.caseId) as { after_state: string };
  assert.match(auditRow.after_state, /seedSignatureRelease/, "the money action is in the audit trail");
  assert.match(auditRow.after_state, /"moves_funds":true/);
});

test("when the escrow module refuses, the ruling does not silently become a payout", async () => {
  // No vault address: `releaseEscrow` bails on its own precondition, which is a
  // guard inside the existing money path rather than one the arbiter invents.
  const s = seedDisputedCase({ escrowAddress: null, solLamports: 40_000_000 });
  nextRuling = { decision: "release_freelancer", reasoning: "Freelancer performed.", cited_ruling_ids: [] };
  await ruleCase(s.caseId, { actorId: OPERATOR });

  const confirmedBefore = count("SELECT COUNT(*) AS n FROM admin_actions WHERE action_type = 'case_confirmed'");
  await assert.rejects(
    () => confirmCase(s.caseId, OPERATOR),
    (err: any) => /escrow not initialized for this job/.test(err.message),
  );

  assert.equal(jobStatus(s.jobId), "disputed", "the contract is untouched after a refused release");
  assert.equal(caseStatus(s.caseId), "ruled", "and the case is not marked confirmed");
  assert.equal(disputeStatus(s.disputeId), "open");
  assert.equal(
    count("SELECT COUNT(*) AS n FROM admin_actions WHERE action_type = 'case_confirmed'"),
    confirmedBefore,
    "a refused release audits nothing",
  );
});

test("the guards: confirm needs a ruling, and nothing is confirmed twice", async () => {
  const s = seedDisputedCase({ solLamports: 10_000_000 });
  await assert.rejects(() => confirmCase(s.caseId, OPERATOR), /no ruling to confirm/);

  nextRuling = { decision: "hold_buyer", reasoning: "Buyer's rejection stands.", cited_ruling_ids: [] };
  await ruleCase(s.caseId, { actorId: OPERATOR });
  await confirmCase(s.caseId, OPERATOR);
  await assert.rejects(() => confirmCase(s.caseId, OPERATOR), /already confirmed/);
  // A confirmed decision is final: re-ruling it would rewrite history.
  await assert.rejects(() => ruleCase(s.caseId, { actorId: OPERATOR }), /already confirmed/);
});

test("a case whose contract is not in dispute cannot be ruled", async () => {
  const buyer = seedUser("client");
  const freelancer = seedUser("freelancer");
  const info = db
    .prepare(
      `INSERT INTO jobs (buyer_id, freelancer_id, title, requirements, usd_budget, status, escrow_address)
       VALUES (?, ?, ?, ?, 40, 'in_progress', ?)`,
    )
    .run(buyer, freelancer, "Logo", "Logo", web3.Keypair.generate().publicKey.toBase58());
  const c = createCase({ rail: "escrow", title: "Not disputed", payload: { job_id: Number(info.lastInsertRowid) } });
  await assert.rejects(() => ruleCase(c.id, { actorId: OPERATOR }), /expected disputed/);
});

test("an escrow case without a job id is rejected before the model is asked", async () => {
  const c = createCase({ rail: "escrow", title: "Orphan case" });
  await assert.rejects(() => ruleCase(c.id, { actorId: OPERATOR }), /payload\.job_id/);
});

test("a remedy that is not on the rulebook is refused, not executed", async () => {
  const s = seedDisputedCase({ solLamports: 10_000_000 });
  // The schema restricts the decision to the rulebook's remedy ids, so this is
  // rejected at validation: no ruling row, nothing to confirm.
  nextRuling = { decision: "refund_the_buyer_and_ban_the_freelancer", reasoning: "invented", cited_ruling_ids: [] };
  await assert.rejects(() => ruleCase(s.caseId, { actorId: OPERATOR }), /must be one of|no cached response/);
  assert.equal(count("SELECT COUNT(*) AS n FROM rulings WHERE case_id = ?", s.caseId), 0);
  assert.equal(caseStatus(s.caseId), "open");
});

test("the model may only cite precedents it was actually shown", async () => {
  const s = seedDisputedCase({ solLamports: 10_000_000 });
  const prior = seedDisputedCase({ solLamports: 10_000_000 });
  nextRuling = { decision: "hold_buyer", reasoning: "Same shape as ruling #1.", cited_ruling_ids: [] };
  const first = await ruleCase(prior.caseId, { actorId: OPERATOR });

  nextRuling = {
    decision: "hold_buyer",
    reasoning: "Follows the earlier ruling.",
    // 999 was never offered; only the real precedent may be recorded.
    cited_ruling_ids: [first.ruling.id, 999],
  };
  const second = await ruleCase(s.caseId, {
    actorId: OPERATOR,
    precedents: [
      {
        id: first.ruling.id,
        caseId: prior.caseId,
        rulebook: first.ruling.rulebook,
        decision: first.ruling.decision,
        reasoning: first.ruling.reasoning,
      },
    ],
  });

  assert.deepEqual(second.citations, [first.ruling.id]);
  const stored = listCitations(second.ruling.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.cited_ruling_id, first.ruling.id);
  assert.equal(stored[0]!.weight, 1);
  assert.equal(getRuling(second.ruling.id)!.decision, "hold_buyer");
});

test("with no precedents offered, nothing can be cited", async () => {
  const s = seedDisputedCase({ solLamports: 10_000_000 });
  nextRuling = { decision: "hold_buyer", reasoning: "Nothing to compare against.", cited_ruling_ids: [1, 2] };
  const result = await ruleCase(s.caseId, { actorId: OPERATOR });
  assert.deepEqual(result.citations, []);
  assert.deepEqual(listCitations(result.ruling.id), []);
});

test("a repeated rule of the same case replays the model's real answer", async () => {
  const s = seedDisputedCase({ solLamports: 10_000_000 });
  nextRuling = { decision: "hold_buyer", reasoning: "Cache me.", cited_ruling_ids: [] };
  const before = providerCalls;
  const first = await ruleCase(s.caseId, { actorId: OPERATOR });
  assert.equal(first.cached, false);
  assert.equal(providerCalls, before + 1);

  const second = await ruleCase(s.caseId, { actorId: OPERATOR });
  assert.equal(second.cached, true, "identical input answers from the cache, with no network");
  assert.equal(providerCalls, before + 1);
  assert.equal(second.ruling.decision, first.ruling.decision);
});

// --- phase 2: HTTP surface -----------------------------------------------------

const tmpHttp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-arbiter-http-"));
function findFreePortSync(): number {
  const srv = net.createServer();
  srv.listen(0);
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  return port;
}
const PORT = String(findFreePortSync());
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
      JWT_SECRET: "test-secret-value-for-arbiter-tests",
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

function api(method: string, url: string, body?: unknown, token?: string) {
  return fetch(`${BASE}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("a disputed contract is ruled and confirmed through HTTP", { timeout: 120_000 }, async (t) => {
  await waitForServer();
  t.after(async () => {
    server.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 400));
    try {
      fs.rmSync(tmpHttp, { recursive: true, force: true });
    } catch {
      /* best-effort on Windows */
    }
  });

  // The server owns this database; the test only reads and seeds state in it.
  const sideDb = new DatabaseSync(path.join(tmpHttp, "app.db"));

  await t.test("anonymous callers cannot rule or confirm", async () => {
    assert.equal((await api("POST", "/arbiter/cases/1/rule")).status, 401);
    assert.equal((await api("POST", "/arbiter/cases/1/confirm")).status, 401);
  });

  await t.test("a disputed contract rules and confirms end to end", async () => {
    const staffSignup = await fetch(`${BASE}/auth/admin-signup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-setup-secret": "test-admin-secret" },
      body: JSON.stringify({ username: "arbops", password: "Str0ng-Pass!" }),
    });
    assert.equal(staffSignup.status, 201);
    const login = await api("POST", "/auth/login", { username: "arbops", password: "Str0ng-Pass!" });
    const { token } = (await login.json()) as { token: string };

    // A non-staff account must not reach the money surface.
    const clientSignup = await api("POST", "/auth/signup", {
      email: `arb.${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: "Str0ng-Pass!",
      role: "client",
    });
    assert.equal(clientSignup.status, 201);
    const clientToken = ((await clientSignup.json()) as { token: string }).token;
    assert.equal((await api("GET", "/arbiter/cases", undefined, clientToken)).status, 403);
    assert.equal((await api("POST", "/arbiter/cases/1/rule", {}, clientToken)).status, 403);
    assert.equal((await api("POST", "/arbiter/cases/1/confirm", {}, clientToken)).status, 403);

    // Seed a real disputed contract: a delivery exists, the buyer rejected it,
    // and the escrow already carries a release row so no chain call is needed.
    const buyer = sideDb
      .prepare("INSERT INTO users (wallet_address, role) VALUES (?, 'client')")
      .run(web3.Keypair.generate().publicKey.toBase58());
    const freelancer = sideDb
      .prepare("INSERT INTO users (wallet_address, role) VALUES (?, 'freelancer')")
      .run(web3.Keypair.generate().publicKey.toBase58());
    const job = sideDb
      .prepare(
        `INSERT INTO jobs (buyer_id, freelancer_id, title, requirements, usd_budget, sol_lamports, status, escrow_address)
         VALUES (?, ?, 'Brand refresh', 'Logo + 5 templates', 80, 60000000, 'disputed', ?)`,
      )
      .run(Number(buyer.lastInsertRowid), Number(freelancer.lastInsertRowid), web3.Keypair.generate().publicKey.toBase58());
    const jobId = Number(job.lastInsertRowid);
    sideDb
      .prepare("INSERT INTO deliveries (job_id, version, note, attachment_urls, submitted_by) VALUES (?, 1, ?, ?, ?)")
      .run(jobId, "v1 drafts", JSON.stringify(["https://drive.example.com/v1.zip"]), Number(freelancer.lastInsertRowid));
    sideDb
      .prepare("INSERT INTO disputes (job_id, raised_by, reason) VALUES (?, ?, ?)")
      .run(jobId, Number(freelancer.lastInsertRowid), "Work followed the brief.");
    sideDb
      .prepare("INSERT INTO escrow_transactions (job_id, tx_signature, instruction_type, amount_lamports) VALUES (?, 'httpTestReleaseSig', 'release', 60000000)")
      .run(jobId);

    const created = await api(
      "POST",
      "/arbiter/cases",
      { rail: "escrow", title: `Dispute on job #${jobId}`, amount: 80, currency: "USD", payload: { job_id: jobId } },
      token,
    );
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const caseId = ((await created.json()) as any).case.id;

    nextRuling = { decision: "release_freelancer", reasoning: "The delivery satisfies the stated requirements.", cited_ruling_ids: [] };
    const ruled = await api("POST", `/arbiter/cases/${caseId}/rule`, {}, token);
    assert.equal(ruled.status, 200, JSON.stringify(await ruled.clone().json()));
    const ruledBody = (await ruled.json()) as any;
    assert.equal(ruledBody.ruling.decision, "release_freelancer");
    assert.equal(ruledBody.ruling.liability_band, "freelancer_delivered");

    // Recommend-only: the HTTP path leaves the contract alone.
    assert.equal(
      (sideDb.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status,
      "disputed",
    );
    assert.equal((await api("GET", `/arbiter/cases/${caseId}`, undefined, token)).status, 200);

    const ruledetail = await api("GET", `/arbiter/rulings/${ruledBody.ruling.id}`, undefined, token);
    assert.equal(ruledetail.status, 200);
    assert.equal(((await ruledetail.json()) as any).ruling.decision, "release_freelancer");

    const confirmed = await api("POST", `/arbiter/cases/${caseId}/confirm`, {}, token);
    assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
    const confirmedBody = (await confirmed.json()) as any;
    assert.equal(confirmedBody.outcome.detail.signature, "httpTestReleaseSig");
    assert.equal(confirmedBody.case.status, "confirmed");
    assert.equal(
      (sideDb.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status,
      "released",
    );
    assert.equal(
      (sideDb.prepare("SELECT status FROM disputes WHERE job_id = ?").get(jobId) as { status: string }).status,
      "ruled",
    );

    const audit = sideDb
      .prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action_type IN ('case_ruled','case_confirmed')")
      .get() as { n: number };
    assert.equal(audit.n, 2, "both the ruling and the confirmation are audited");

    assert.equal((await api("POST", `/arbiter/cases/${caseId}/confirm`, {}, token)).status, 409);
  });

  sideDb.close();
});
