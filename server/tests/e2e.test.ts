import * as web3 from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";

/**
 * End-to-end tests: drive the real HTTP API against Solana devnet and assert
 * on-chain truth (balances move, signatures confirm, escrow accounts empty on release).
 * These tests hit the real network — that is the point (PRD: "real transactions only").
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-test-"));
process.env.DATA_DIR = tmp;
process.env.KEYS_DIR = tmp;
process.env.PORT = String(findFreePortSync());
process.env.JWT_SECRET = "test-secret";
if (process.env.TEST_SOLANA_RPC_URL) process.env.SOLANA_RPC_URL = process.env.TEST_SOLANA_RPC_URL;

const { db } = await import("../db.ts");
const { config, explorerTx } = await import("../config.ts");
const { conn, requestAirdrop, getSolBalance } = await import("../solana.ts");
const { seedTaxonomy } = await import("../seed.ts");
const { platformKeypair } = await import("../keys.ts");

const BASE = `http://localhost:${config.port}`;

// --- start the real server as a child process (env/ports isolated) ----
const server = spawn(process.execPath, [
  "--experimental-strip-types",
  "--experimental-transform-types",
  "--env-file-if-exists=.env",
  "server/server.ts",
], { env: { ...process.env, PORT: String(config.port), DATA_DIR: tmp, KEYS_DIR: tmp } });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/meta/network`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

server.stdout.on("data", (d) => process.stdout.write(d));
server.stderr.on("data", (d) => process.stderr.write(d));

before(async () => {
  try {
    await waitForServer();
    await seedTaxonomy();
    for (let i = 0; i < 5; i++) {
      try {
        await requestAirdrop(platformKeypair().publicKey);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } catch (err) {
    server.kill();
    throw err;
  }
  console.error("BEFORE_DONE port=" + config.port);
});

after(() => {
  return new Promise((resolve) => {
    server.once("close", resolve);
    server.kill("SIGTERM");
  });
});

async function api(
  method: string,
  p: string,
  body?: unknown,
  token?: string
) : Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    signal: AbortSignal.timeout(120_000),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Fund a test wallet from the devnet faucet with a hard attempt cap. */
async function ensureFunded(kp: web3.Keypair, minLamports: number): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const bal = await getSolBalance(kp.publicKey);
    if (bal >= minLamports) return;
    try {
      await requestAirdrop(kp.publicKey);
    } catch {
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  const bal = await getSolBalance(kp.publicKey);
  assert.ok(
    bal >= minLamports,
    `could not fund test wallet ${kp.publicKey.toBase58()} (devnet faucet rate limit). Top up manually and re-run.`
  );
}

function findFreePortSync(): number {
  const srv = net.createServer();
  srv.listen(0);
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  return port;
}

test("e2e: full marketplace lifecycle on devnet", { timeout: 600_000 }, async (t) => {
  await t.test("auth: wallet challenge + signature verification", async () => {
    const bad = await api("POST", "/auth/verify", { wallet: web3.Keypair.generate().publicKey.toBase58(), signature: "x", nonce: "y" });
    assert.equal(bad.status, 401);
    const client = await login("client", "client");
    assert.ok(client.token);
    assert.equal(client.user.role, "client");
  });

  const client = await login("client2", "client");
  const freelancerA = await login("freelancerA", "freelancer");
  const freelancerB = await login("freelancerB", "freelancer");
  const support = await login("support", "support");
  const dev = await login("dev", "dev");
  let jobId = 0;
  let escrowAddress = "";
  let solLamports = 0;

  await t.test("rbac: freelancer cannot post jobs, user cannot access admin", async () => {
    const r1 = await api("POST", "/jobs", { title: "x", requirements: "y", usd_budget: 10 }, freelancerA.token);
    assert.equal(r1.status, 403);
    const r2 = await api("GET", "/admin/audit", undefined, client.token);
    assert.equal(r2.status, 403);
    const r3 = await api("GET", "/admin/health", undefined, dev.token);
    assert.equal(r3.status, 200);
  });

  await t.test("gemini: price endpoint returns a real rate", async () => {
    const r = await api("GET", "/meta/price");
    assert.equal(r.status, 200);
    assert.ok(r.json.rate > 0, `rate: ${JSON.stringify(r.json)}`);
  });

  await t.test("job creation gets a real Gemini SOL quote", async () => {
    const r = await api("POST", "/jobs", { title: "Logo + landing page", requirements: "Modern logo and one-page site", usd_budget: 25 }, client.token);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    jobId = r.json.job.id;
    solLamports = r.json.sol_lamports;
    assert.ok(solLamports > 1_000_000);
    assert.equal(r.json.job.status, "created");
  });

  await t.test("escrow init creates a real on-chain account", async () => {
    const r = await api("POST", `/escrow/${jobId}/init`, {}, client.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    escrowAddress = r.json.address;
    const info = await conn.getAccountInfo(new web3.PublicKey(escrowAddress), "confirmed");
    assert.ok(info, "escrow account must exist on-chain");
    assert.ok(info.lamports >= 890_880);
  });

  await t.test("buyer signs and funds escrow with a real tx; balance verifiable on-chain", async () => {
    const buyerKp = localWallets.get("client2")!;
    await ensureFunded(buyerKp, solLamports + 1_000_000);
    const bh = await conn.getLatestBlockhash();
    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: buyerKp.publicKey,
        toPubkey: new web3.PublicKey(escrowAddress),
        lamports: solLamports,
      })
    );
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = buyerKp.publicKey;
    tx.sign(buyerKp);
    const raw = tx.serialize();
    const sig = bs58.encode(tx.signatures[0]!.signature!);

    const r = await api("POST", `/escrow/${jobId}/fund/confirm`, { raw_tx_hex: Buffer.from(raw).toString("hex"), signature: sig }, client.token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const bal = await getSolBalance(new web3.PublicKey(escrowAddress));
    assert.ok(bal >= solLamports, `escrow balance ${bal} >= ${solLamports}`);
    const recorded = await api("GET", `/jobs/${jobId}`, undefined, client.token);
    const fundTx = recorded.json.escrow_transactions.find((x: any) => x.instruction_type === "fund");
    assert.ok(fundTx, "fund tx recorded");
    assert.equal(fundTx.explorer_url, explorerTx(fundTx.tx_signature));
    // idempotency: re-confirm returns same signature, no new record
    const r2 = await api("POST", `/escrow/${jobId}/fund/confirm`, { raw_tx_hex: Buffer.from(raw).toString("hex"), signature: sig }, client.token);
    assert.equal(r2.json.alreadyRecorded, true);
    assert.equal(r2.json.signature, sig);
  });

  await t.test("freelancer onboarding: portfolio gate blocks applications until published", async () => {
    const r0 = await api("POST", `/jobs/${jobId}/apply`, { message: "hi" }, freelancerA.token);
    assert.equal(r0.status, 403, "must be blocked before portfolio publish");
    await api("POST", "/me/onboarding", { headline: "Full-stack dev", bio: "10 years", subdomain_ids: [8, 9] }, freelancerA.token);
    await api("POST", "/me/portfolio", { title: "Site A", media_url: "https://example.com/a.png", media_type: "image" }, freelancerA.token);
    const pub = await api("POST", "/me/portfolio/publish", {}, freelancerA.token);
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    const dir = await api("GET", "/freelancers", undefined, client.token);
    assert.equal(dir.status, 200);
    assert.ok(dir.json.freelancers.some((f: any) => f.id === freelancerA.user.id));
  });

  await t.test("applications: B applies, client accepts A; state machine enforced", async () => {
    const pub2 = await (async () => {
      await api("POST", "/me/onboarding", { headline: "Designer", bio: "logos", subdomain_ids: [5, 6] }, freelancerB.token);
      await api("POST", "/me/portfolio", { title: "Logo B", media_url: "https://example.com/b.png" }, freelancerB.token);
      return api("POST", "/me/portfolio/publish", {}, freelancerB.token);
    })();
    assert.equal(pub2.status, 200);
    const a1 = await api("POST", `/jobs/${jobId}/apply`, { message: "I can do this", offered_price_sol: 0.15 }, freelancerA.token);
    assert.equal(a1.status, 201, JSON.stringify(a1.json));
    const a2 = await api("POST", `/jobs/${jobId}/apply`, { message: "me too" }, freelancerB.token);
    assert.equal(a2.status, 201);
    const dup = await api("POST", `/jobs/${jobId}/apply`, { message: "again" }, freelancerA.token);
    assert.equal(dup.status, 409);
    const list = await api("GET", `/jobs/${jobId}/applications`, undefined, client.token);
    assert.equal(list.json.applications.length, 2);
    const accept = await api("POST", `/jobs/${jobId}/applications/${list.json.applications[0].id}/accept`, {}, client.token);
    assert.equal(accept.status, 200, JSON.stringify(accept.json));
    assert.equal(accept.json.job.status, "negotiating");
    const early = await api("POST", `/jobs/${jobId}/deliveries`, { attachment_urls: ["https://x.com/w.zip"] }, freelancerA.token);
    assert.equal(early.status, 409);
  });

  await t.test("negotiation: offer, counter, both-agreed flag", async () => {
    const o1 = await api("POST", `/jobs/${jobId}/negotiate`, { price_sol: 0.12, scope: "logo + landing" }, freelancerA.token);
    assert.equal(o1.status, 201);
    const selfAgree = await api("POST", `/jobs/${jobId}/agree`, {}, freelancerA.token);
    assert.equal(selfAgree.status, 409, "offer maker cannot agree to own offer");
    const cAgree = await api("POST", `/jobs/${jobId}/agree`, {}, client.token);
    assert.equal(cAgree.status, 200);
    assert.equal(cAgree.json.negotiation.client_agreed, 1);
    assert.equal(cAgree.json.job.status, "agreed");
  });

  await t.test("delivery → approve releases REAL SOL to freelancer wallet", async () => {
    const start = await api("POST", `/jobs/${jobId}/start`, {}, freelancerA.token);
    assert.equal(start.status, 200);
    const d = await api(
      "POST",
      `/jobs/${jobId}/deliveries`,
      { note: "v1", attachment_urls: ["https://example.com/delivery.zip"] },
      freelancerA.token
    );
    assert.equal(d.status, 201);
    const before = await getSolBalance(new web3.PublicKey(freelancerA.user.wallet_address));
    const approve = await api("POST", `/jobs/${jobId}/approve`, {}, client.token);
    assert.equal(approve.status, 200, JSON.stringify(approve.json));
    assert.equal(approve.json.job.status, "released");
    assert.ok(approve.json.release.signature, "release signature present");
    const after = await getSolBalance(new web3.PublicKey(freelancerA.user.wallet_address));
    assert.ok(after > before, `freelancer balance must increase (${before} -> ${after})`);
    const esc = await getSolBalance(new web3.PublicKey(escrowAddress));
    assert.ok(esc <= 900_880 + 10_000, "escrow emptied back to rent floor after release");
  });

  await t.test("rejection → backoff triggers REAL on-chain refund", async () => {
    const j = await api("POST", "/jobs", { title: "Social kit", requirements: "5 templates", usd_budget: 10 }, client.token);
    const j2 = j.json.job.id;
    await api("POST", `/escrow/${j2}/init`, {}, client.token);
    const jobRow = db.prepare("SELECT escrow_address, sol_lamports FROM jobs WHERE id = ?").get(j2) as any;
    const buyerKp = localWallets.get("client2")!;
    await ensureFunded(buyerKp, jobRow.sol_lamports + 1_000_000);
    const bh = await conn.getLatestBlockhash();
    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({ fromPubkey: buyerKp.publicKey, toPubkey: new web3.PublicKey(jobRow.escrow_address), lamports: jobRow.sol_lamports })
    );
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = buyerKp.publicKey;
    tx.sign(buyerKp);
    const fund = await api("POST", `/escrow/${j2}/fund/confirm`, { raw_tx_hex: Buffer.from(tx.serialize()).toString("hex"), signature: bs58.encode(tx.signatures[0]!.signature!) }, client.token);
    assert.equal(fund.status, 200, JSON.stringify(fund.json));
    await api("POST", `/jobs/${j2}/apply`, { message: "ready" }, freelancerB.token);
    const apps = await api("GET", `/jobs/${j2}/applications`, undefined, client.token);
    await api("POST", `/jobs/${j2}/applications/${apps.json.applications[0].id}/accept`, {}, client.token);
    await api("POST", `/jobs/${j2}/negotiate`, { price_sol: 0.05, scope: "5 templates" }, freelancerB.token);
    await api("POST", `/jobs/${j2}/agree`, {}, client.token);
    await api("POST", `/jobs/${j2}/start`, {}, freelancerB.token);
    await api("POST", `/jobs/${j2}/deliveries`, { attachment_urls: ["https://example.com/kit.zip"] }, freelancerB.token);
    const rej = await api("POST", `/jobs/${j2}/reject`, { reason: "wrong brand colors" }, client.token);
    assert.equal(rej.status, 200);
    const buyerBefore = await getSolBalance(buyerKp.publicKey);
    const backoff = await api("POST", `/jobs/${j2}/backoff`, {}, freelancerB.token);
    assert.equal(backoff.status, 200, JSON.stringify(backoff.json));
    const buyerAfter = await getSolBalance(buyerKp.publicKey);
    assert.ok(buyerAfter > buyerBefore, `buyer refunded on-chain (${buyerBefore} -> ${buyerAfter})`);
  });

  await t.test("dispute: escalate auto-opens ticket; support rules hold_buyer; close refunds", async () => {
    const j = await api("POST", "/jobs", { title: "Disputed gig", requirements: "banner set", usd_budget: 8 }, client.token);
    const j3 = j.json.job.id;
    await api("POST", `/escrow/${j3}/init`, {}, client.token);
    const jobRow = db.prepare("SELECT escrow_address, sol_lamports FROM jobs WHERE id = ?").get(j3) as any;
    const buyerKp = localWallets.get("client2")!;
    await ensureFunded(buyerKp, jobRow.sol_lamports + 1_000_000);
    const bh = await conn.getLatestBlockhash();
    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({ fromPubkey: buyerKp.publicKey, toPubkey: new web3.PublicKey(jobRow.escrow_address), lamports: jobRow.sol_lamports })
    );
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = buyerKp.publicKey;
    tx.sign(buyerKp);
    const fund = await api("POST", `/escrow/${j3}/fund/confirm`, { raw_tx_hex: Buffer.from(tx.serialize()).toString("hex"), signature: bs58.encode(tx.signatures[0]!.signature!) }, client.token);
    assert.equal(fund.status, 200);
    await api("POST", `/jobs/${j3}/apply`, { message: "banners" }, freelancerA.token);
    const apps = await api("GET", `/jobs/${j3}/applications`, undefined, client.token);
    await api("POST", `/jobs/${j3}/applications/${apps.json.applications[0].id}/accept`, {}, client.token);
    await api("POST", `/jobs/${j3}/negotiate`, { price_sol: 0.04, scope: "banners" }, freelancerA.token);
    await api("POST", `/jobs/${j3}/agree`, {}, client.token);
    await api("POST", `/jobs/${j3}/start`, {}, freelancerA.token);
    await api("POST", `/jobs/${j3}/deliveries`, { attachment_urls: ["https://example.com/banners.zip"] }, freelancerA.token);
    await api("POST", `/jobs/${j3}/reject`, { reason: "not per brief" }, client.token);
    const esc = await api("POST", `/jobs/${j3}/escalate`, { reason: "work followed the brief" }, freelancerA.token);
    assert.equal(esc.status, 201, JSON.stringify(esc.json));
    const tickets = await api("GET", "/tickets", undefined, support.token);
    assert.ok(tickets.json.tickets.some((x: any) => x.dispute_id ?? x.subject.includes("Dispute")));
    const queue = await api("GET", "/disputes", undefined, support.token);
    const d = queue.json.disputes.find((x: any) => x.job_id === j3);
    const rule = await api("POST", `/disputes/${d.id}/rule`, { outcome: "hold_buyer", notes: "rejection reasonable" }, support.token);
    assert.equal(rule.status, 200, JSON.stringify(rule.json));
    const detail = await api("GET", `/jobs/${j3}`, undefined, client.token);
    assert.equal(detail.json.job.status, "held_detached");
    const buyerBefore = await getSolBalance(buyerKp.publicKey);
    const close = await api("POST", `/jobs/${j3}/close-held`, {}, client.token);
    assert.equal(close.status, 200, JSON.stringify(close.json));
    const buyerAfter = await getSolBalance(buyerKp.publicKey);
    assert.ok(buyerAfter > buyerBefore, "buyer refunded after closing held job");
  });

  await t.test("support can rule release_freelancer (real on-chain release)", async () => {
    const j = await api("POST", "/jobs", { title: "Release-rule gig", requirements: "voiceover", usd_budget: 8 }, client.token);
    const j4 = j.json.job.id;
    await api("POST", `/escrow/${j4}/init`, {}, client.token);
    const jobRow = db.prepare("SELECT escrow_address, sol_lamports FROM jobs WHERE id = ?").get(j4) as any;
    const buyerKp = localWallets.get("client2")!;
    await ensureFunded(buyerKp, jobRow.sol_lamports + 1_000_000);
    const bh = await conn.getLatestBlockhash();
    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({ fromPubkey: buyerKp.publicKey, toPubkey: new web3.PublicKey(jobRow.escrow_address), lamports: jobRow.sol_lamports })
    );
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = buyerKp.publicKey;
    tx.sign(buyerKp);
    await api("POST", `/escrow/${j4}/fund/confirm`, { raw_tx_hex: Buffer.from(tx.serialize()).toString("hex"), signature: bs58.encode(tx.signatures[0]!.signature!) }, client.token);
    await api("POST", `/jobs/${j4}/apply`, { message: "vo" }, freelancerA.token);
    const apps = await api("GET", `/jobs/${j4}/applications`, undefined, client.token);
    await api("POST", `/jobs/${j4}/applications/${apps.json.applications[0].id}/accept`, {}, client.token);
    await api("POST", `/jobs/${j4}/negotiate`, { price_sol: 0.03, scope: "vo" }, freelancerA.token);
    await api("POST", `/jobs/${j4}/agree`, {}, client.token);
    await api("POST", `/jobs/${j4}/start`, {}, freelancerA.token);
    await api("POST", `/jobs/${j4}/deliveries`, { attachment_urls: ["https://example.com/vo.mp3"] }, freelancerA.token);
    await api("POST", `/jobs/${j4}/reject`, { reason: "meh" }, client.token);
    const esc = await api("POST", `/jobs/${j4}/escalate`, { reason: "it was fine" }, freelancerA.token);
    assert.equal(esc.status, 201);
    const queue = await api("GET", "/disputes", undefined, support.token);
    const d = queue.json.disputes.find((x: any) => x.job_id === j4);
    const freelancerBefore = await getSolBalance(new web3.PublicKey(freelancerA.user.wallet_address));
    const rule = await api("POST", `/disputes/${d.id}/rule`, { outcome: "release_freelancer", notes: "buyer wrong" }, support.token);
    assert.equal(rule.status, 200, JSON.stringify(rule.json));
    const freelancerAfter = await getSolBalance(new web3.PublicKey(freelancerA.user.wallet_address));
    assert.ok(freelancerAfter > freelancerBefore, "support ruling releases REAL funds to freelancer");
  });

  await t.test("leaderboard, audit, user management, help desk, reconciliation", async () => {
    const lb = await api("GET", "/leaderboard");
    assert.equal(lb.status, 200);
    assert.ok(Array.isArray(lb.json.leaderboard));
    const auditR = await api("GET", "/admin/audit", undefined, dev.token);
    assert.equal(auditR.status, 200);
    assert.ok(auditR.json.actions.length > 0, "audit trail has entries");
    const users = await api("GET", "/admin/users", undefined, support.token);
    assert.equal(users.status, 200);
    const me = users.json.users.find((u: any) => u.id === freelancerA.user.id);
    assert.ok(Number(me.jobs_completed) >= 1, "per-user activity visible");
    const sup = await api("GET", "/admin/health", undefined, support.token);
    assert.equal(sup.status, 403, "support cannot access dev-only health");
    const ticket = await api("POST", "/tickets", { subject: "Question", body: "How do payouts work?" }, freelancerB.token);
    assert.equal(ticket.status, 201);
    const tid = ticket.json.ticket;
    const reply = await api("POST", `/tickets/${tid}/reply`, { body: "Released SOL is withdrawable from your wallet anytime." }, support.token);
    assert.equal(reply.status, 200);
    const resolve = await api("POST", `/tickets/${tid}/resolve`, {}, support.token);
    assert.equal(resolve.status, 200);
    const rec = await api("GET", "/admin/reconciliation", undefined, dev.token);
    assert.equal(rec.status, 200);
    assert.ok(Array.isArray(rec.json.reconciliations));
  });
});


async function login(name: string, role: string): Promise<{ token: string; user: any }> {
  const kp = web3.Keypair.generate();
  localWallets.set(name, kp);
  const wallet = kp.publicKey.toBase58();
  const ch = await api("POST", "/auth/challenge", { wallet });
  assert.equal(ch.status, 200, `challenge failed: ${JSON.stringify(ch.json)}`);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(ch.json.message), kp.secretKey));
  const v = await api("POST", "/auth/verify", { wallet, signature, nonce: ch.json.nonce, role });
  assert.equal(v.status, 200, `verify failed: ${JSON.stringify(v.json)}`);
  return { token: v.json.token, user: v.json.user };
}

const localWallets = new Map<string, web3.Keypair>();
