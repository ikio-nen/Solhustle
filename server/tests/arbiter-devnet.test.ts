import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import * as web3 from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { DatabaseSync } from "node:sqlite";

/**
 * The money test: a disputed contract is ruled and confirmed over HTTP, and the
 * confirmation moves **real devnet SOL** out of the escrow vault to the
 * freelancer through `escrow.releaseEscrow`.
 *
 * This is the only test in the suite that touches the chain, and it is written
 * to need nothing but a funded platform wallet: no devnet faucet (it is
 * rate-limited often enough to be useless), and no Gemini quote, because the
 * job row is seeded directly. The platform wallet funds the buyer through the
 * app's own deposit path, the buyer signs the deposit, and the vault is drained
 * by the arbiter's confirm. If the platform wallet is dry the test skips with
 * the reason rather than failing, since a dry wallet is not a defect in the code
 * under test.
 *
 * NOTE: it uses the repository's real `keys/` directory, because the platform
 * wallet that banks every deposit lives there. It writes a sandboxed
 * `escrow_<jobId>.json` (job ids here are deliberately huge to stay clear of the
 * demo's own vaults) and nothing else.
 */

const repoRoot = path.resolve(import.meta.dirname, "../..");
const DEPOSIT_LAMPORTS = 6_000_000; // 0.006 SOL — enough to observe, small enough to repeat
const JOB_ID = 900_001; // far outside the demo's range, so keys/escrow_<id>.json is ours alone

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyaya-devnet-"));

// --- stub provider -------------------------------------------------------------

const nextRuling = { decision: "release_freelancer", reasoning: "The delivery meets the stated requirements.", cited_ruling_ids: [] };
const stub = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(nextRuling) } }] }));
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as net.AddressInfo).port;
after(() => stub.close());

process.env.DATA_DIR = tmp;
process.env.KEYS_DIR = path.join(repoRoot, "keys");
process.env.SEED_DEMO_ACCOUNTS = "false";
process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/none";

// The schema has to exist before the server boots, so the test process creates it.
const { db } = await import("../db.ts");
db.close();

const RPC = process.env.SOLANA_RPC_URL || web3.clusterApiUrl("devnet");
const conn = new web3.Connection(RPC, "confirmed");

/**
 * The vault keypair lives on disk while the database is thrown away, so a second
 * run would reuse an address that still holds the previous run's deposit and the
 * balance assertions would quietly measure two deposits. Clearing it makes the
 * vault fresh, and therefore makes this test repeatable.
 */
const vaultKeyFile = path.join(repoRoot, "keys", `escrow_${JOB_ID}.json`);
fs.rmSync(vaultKeyFile, { force: true });

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
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT,
      DATA_DIR: tmp,
      KEYS_DIR: path.join(repoRoot, "keys"),
      NODE_ENV: "development",
      JWT_SECRET: "test-secret-value-for-devnet-arbiter",
      ADMIN_SETUP_SECRET: "test-admin-secret",
      SEED_DEMO_ACCOUNTS: "false",
      DATABASE_URL: "postgresql://user:pass@127.0.0.1:1/none",
      CHAIN: "devnet",
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
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(`${BASE}/meta/network`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}

async function api(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    signal: AbortSignal.timeout(120_000),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

/**
 * Read a balance once it has actually changed.
 *
 * The public devnet RPC will happily answer `getBalance` from a node that has not
 * caught up with a transaction the app has already confirmed, which reads as "the
 * money never moved" and makes this test fail for a reason that is not in the code
 * under test. Poll until the balance differs from what it was, then let the
 * assertion judge the amount.
 */
async function balanceOnceChanged(addr: web3.PublicKey, before: number, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = await conn.getBalance(addr, "confirmed");
  while (seen === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    seen = await conn.getBalance(addr, "confirmed");
  }
  return seen;
}

async function loginWallet(kp: web3.Keypair, role: string): Promise<string> {
  const wallet = kp.publicKey.toBase58();
  const ch = await api("POST", "/auth/challenge", { wallet });
  assert.equal(ch.status, 200, `challenge failed: ${ch.text}`);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(ch.json.message), kp.secretKey));
  const v = await api("POST", "/auth/verify", { wallet, signature, nonce: ch.json.nonce, role });
  assert.equal(v.status, 200, `verify failed: ${v.text}`);
  return v.json.token as string;
}

test("a confirmed release moves real devnet SOL out of the escrow vault", { timeout: 420_000 }, async (t) => {
  await waitForServer();
  t.after(async () => {
    server.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 400));
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(vaultKeyFile, { force: true });
    } catch {
      /* best-effort on Windows */
    }
  });

  const sideDb = new DatabaseSync(path.join(tmp, "app.db"));

  const staff = await fetch(`${BASE}/auth/admin-signup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-setup-secret": "test-admin-secret" },
    body: JSON.stringify({ username: "devnetarb", password: "Str0ng-Pass!" }),
  });
  assert.equal(staff.status, 201, await staff.text());
  const staffLogin = await api("POST", "/auth/login", { username: "devnetarb", password: "Str0ng-Pass!" });
  const operator = staffLogin.json.token as string;

  const clientKp = web3.Keypair.generate();
  const freelancerKp = web3.Keypair.generate();
  const clientToken = await loginWallet(clientKp, "client");
  const freelancerToken = await loginWallet(freelancerKp, "freelancer");
  const clientId = (sideDb.prepare("SELECT id FROM users WHERE wallet_address = ?").get(clientKp.publicKey.toBase58()) as { id: number }).id;
  const freelancerId = (sideDb.prepare("SELECT id FROM users WHERE wallet_address = ?").get(freelancerKp.publicKey.toBase58()) as { id: number }).id;

  // The freelancer has to be able to apply at all.
  const subdomain = sideDb.prepare("SELECT id FROM subdomains ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  assert.ok(subdomain, "the server seeded the taxonomy on boot");
  const onboard = await api("POST", "/me/onboarding", { headline: "Motion designer", bio: "Ten years of launch films.", subdomain_ids: [subdomain.id] }, freelancerToken);
  assert.equal(onboard.status, 200, onboard.text);
  const item = await api("POST", "/me/portfolio", { title: "Launch film", media_url: "https://example.com/reel.png", media_type: "image" }, freelancerToken);
  assert.equal(item.status, 201, item.text);
  const publish = await api("POST", "/me/portfolio/publish", {}, freelancerToken);
  assert.equal(publish.status, 200, publish.text);

  // A funded, disputed contract — the state the escrow rail rules on. The job row
  // is seeded directly so the test needs neither the faucet nor a price oracle.
  sideDb
    .prepare(
      `INSERT INTO jobs (id, buyer_id, freelancer_id, title, requirements, usd_budget, sol_amount, sol_lamports, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created')`,
    )
    .run(JOB_ID, clientId, freelancerId, "Devnet release proof", "Deliver the launch film.", 1, DEPOSIT_LAMPORTS / 1e9, DEPOSIT_LAMPORTS);

  // 1. Deposit, funded by the platform wallet through the app's own top-up path.
  const build = await api("POST", `/escrow/${JOB_ID}/fund/build-tx`, {}, clientToken);
  if (build.status !== 200) {
    t.skip(`cannot fund a deposit in this environment (${build.status}): ${build.text.slice(0, 200)}`);
    sideDb.close();
    return;
  }
  const { to, lamports, blockhash } = build.json as { to: string; lamports: number; blockhash: string };
  const vault = new web3.PublicKey(to);
  const vaultBefore = await conn.getBalance(vault, "confirmed");

  const deposit = new web3.Transaction().add(
    web3.SystemProgram.transfer({ fromPubkey: clientKp.publicKey, toPubkey: vault, lamports }),
  );
  deposit.recentBlockhash = blockhash;
  deposit.feePayer = clientKp.publicKey;
  deposit.sign(clientKp);
  const depositSig = bs58.encode(deposit.signatures[0]!.signature!);
  const funded = await api(
    "POST",
    `/escrow/${JOB_ID}/fund/confirm`,
    { raw_tx_hex: deposit.serialize().toString("hex"), signature: depositSig },
    clientToken,
  );
  assert.equal(funded.status, 200, funded.text);
  const vaultAfterDeposit = await balanceOnceChanged(vault, vaultBefore);
  assert.equal(vaultAfterDeposit - vaultBefore, lamports, "the vault really received the deposit");

  // 2. Walk the contract to a dispute over the existing HTTP surface.
  //
  // Note the shape of the current state machine: `acceptApplication` moves the
  // contract straight to `in_progress`, so the negotiate/agree endpoints are not
  // reachable on this path and are skipped. (e2e still asserts "negotiating"
  // there, which is one more way that suite is stale beyond the staff-invite
  // gate.) The dispute itself is what matters here.
  const apply = await api("POST", `/jobs/${JOB_ID}/apply`, { message: "I can start today." }, freelancerToken);
  assert.equal(apply.status, 201, apply.text);
  const apps = await api("GET", `/jobs/${JOB_ID}/applications`, undefined, clientToken);
  const accept = await api("POST", `/jobs/${JOB_ID}/applications/${apps.json.applications[0].id}/accept`, {}, clientToken);
  assert.equal(accept.status, 200, accept.text);
  const delivery = await api(
    "POST",
    `/jobs/${JOB_ID}/deliveries`,
    { attachment_urls: ["https://example.com/final.mp4"] },
    freelancerToken,
  );
  assert.equal(delivery.status, 201, delivery.text);
  const reject = await api("POST", `/jobs/${JOB_ID}/reject`, { reason: "The grade is wrong." }, clientToken);
  assert.equal(reject.status, 200, reject.text);
  const escalate = await api("POST", `/jobs/${JOB_ID}/escalate`, { reason: "It matches the brief." }, freelancerToken);
  assert.equal(escalate.status, 201, escalate.text);
  assert.equal((sideDb.prepare("SELECT status FROM jobs WHERE id = ?").get(JOB_ID) as { status: string }).status, "disputed");

  const openCase = await api("POST", "/arbiter/cases", { rail: "escrow", title: "Devnet release proof", payload: { job_id: JOB_ID } }, operator);
  assert.equal(openCase.status, 201, openCase.text);
  const caseId = openCase.json.case.id as number;

  // 3. Rule: a recommendation only.
  const ruled = await api("POST", `/arbiter/cases/${caseId}/rule`, {}, operator);
  assert.equal(ruled.status, 200, ruled.text);
  assert.equal(ruled.json.ruling.decision, "release_freelancer");
  assert.equal((sideDb.prepare("SELECT status FROM jobs WHERE id = ?").get(JOB_ID) as { status: string }).status, "disputed");

  // 4. Confirm: the money moves, through escrow.releaseEscrow.
  const freelancerBefore = await conn.getBalance(freelancerKp.publicKey, "confirmed");
  const confirmed = await api("POST", `/arbiter/cases/${caseId}/confirm`, {}, operator);
  assert.equal(confirmed.status, 200, confirmed.text);
  const detail = confirmed.json.outcome.detail as { signature: string; alreadyRecorded: boolean; payoutLamports: number };
  assert.equal(detail.alreadyRecorded, false, "this is a fresh on-chain release, not a replay");
  assert.equal(detail.payoutLamports, vaultAfterDeposit);

  const freelancerAfter = await balanceOnceChanged(freelancerKp.publicKey, freelancerBefore);
  assert.ok(
    freelancerAfter > freelancerBefore,
    `the freelancer was paid on-chain (${freelancerBefore} -> ${freelancerAfter})`,
  );
  assert.ok(
    freelancerAfter - freelancerBefore >= detail.payoutLamports - 10_000,
    "the freelancer received the vault's balance less at most the fee",
  );

  const vaultAfterRelease = await balanceOnceChanged(vault, vaultAfterDeposit);
  assert.ok(vaultAfterRelease <= 900_880, `the vault was drained (${vaultAfterRelease} left)`);

  assert.equal((sideDb.prepare("SELECT status FROM jobs WHERE id = ?").get(JOB_ID) as { status: string }).status, "released");
  assert.equal((sideDb.prepare("SELECT status FROM cases WHERE id = ?").get(caseId) as { status: string }).status, "confirmed");
  assert.equal((sideDb.prepare("SELECT status FROM disputes WHERE job_id = ?").get(JOB_ID) as { status: string }).status, "ruled");

  const tx = sideDb
    .prepare("SELECT tx_signature, amount_lamports, instruction_type FROM escrow_transactions WHERE job_id = ? AND instruction_type = 'release'")
    .get(JOB_ID) as { tx_signature: string; amount_lamports: number; instruction_type: string } | undefined;
  assert.ok(tx, "the release is on the escrow ledger");
  assert.equal(tx!.tx_signature, detail.signature);
  assert.equal(tx!.amount_lamports, detail.payoutLamports);
  console.log(`   on-chain release: https://solscan.io/tx/${tx!.tx_signature}?cluster=devnet`);

  sideDb.close();
});
