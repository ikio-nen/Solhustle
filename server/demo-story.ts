import * as web3 from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.ts";
import { config } from "./config.ts";
import { ensureDemoActors, seedTaxonomy } from "./seed.ts";
import { requestAirdrop, conn, buildSignedTransfer } from "./solana.ts";
import { quoteUsdToSol } from "./gemini.ts";
import { recomputeLeaderboard } from "./leaderboard.ts";
import { initEscrow, fundEscrow, releaseEscrow, refundEscrow } from "./escrow.ts";
import { audit } from "./audit.ts";


/**
 * Demo story: the complete marketplace lifecycle with REAL devnet transactions,
 * runnable headlessly (npm run demo-story) before/while the hackathon presentation.
 *
 * Act 1: client posts "Product launch video edit", funds escrow → freelancerA applies,
 *        gets accepted, offer agreed, delivers, buyer approves → REAL on-chain release.
 * Act 2: second job to dispute: client rejects, freelancerA escalates, support rules
 *        hold_buyer → funds held, freelancer detached; client closes → REAL refund.
 * Then leaderboard recompute + summary printout.
 */

const log = (...a: unknown[]) => console.log(...a);

async function insertJob(opts: {
  buyerId: number;
  title: string;
  requirements: string;
  usd: number;
}): Promise<{ id: number; solLamports: number }> {
  const quote = await quoteUsdToSol(opts.usd);
  const solLamports = Math.ceil(quote.sol * 1e9);
  const info = db
    .prepare(
      `INSERT INTO jobs (buyer_id, title, requirements, usd_budget, sol_amount, sol_lamports, price_rate, price_source, price_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(opts.buyerId, opts.title, opts.requirements, opts.usd, solLamports / 1e9, solLamports, quote.rate, quote.source, quote.fetchedAt);
  return { id: Number(info.lastInsertRowid), solLamports };
}

async function main(): Promise<void> {
  log(`\n🎬 DEMO STORY — network: ${config.chain}\n`);
  await seedTaxonomy();
  const actors = await ensureDemoActors(true);
  const byName = (n: string) => actors.find((a) => a.name === n)!;
  const client = byName("client");
  const freelancerA = byName("freelancerA");
  const freelancerB = byName("freelancerB");
  const support = byName("support");

  const balances = async (label: string) => {
    for (const a of [client, freelancerA, freelancerB]) {
      const bal = await conn.getBalance(new web3.PublicKey(a.wallet), "confirmed");
      log(`   ${label} ${a.name}: ${(bal / 1e9).toFixed(4)} SOL`);
    }
  };

  await balances("before  ");

  // ---------------- ACT 1 — happy path release ----------------
  log("\n— Act 1: post, fund, negotiate, deliver, approve —");
  const { id: job1, solLamports: lamports1 } = await insertJob({
    buyerId: client.userId,
    title: "Product launch video edit",
    requirements: "90-second launch video: motion graphics intro, velocity edits, caption styling. Deliver MP4 + project files.",
    usd: 150,
  });
  log(`   job #${job1} created — $150 → ${lamports1 / 1e9} SOL (Gemini rate stored on the job)`);

  const esc1 = await initEscrow({ id: job1, escrow_address: null });
  log(`   escrow account: ${esc1.address} (rent-min funded by platform)`);

  db.prepare("INSERT INTO job_applications (job_id, freelancer_id, message) VALUES (?, ?, ?)").run(
    job1,
    freelancerA.userId,
    "I do exactly this — motion graphics + velocity edits. 5-day turnaround."
  );
  const app1 = db.prepare("SELECT id FROM job_applications WHERE job_id = ? AND freelancer_id = ?").get(job1, freelancerA.userId) as { id: number };
  db.prepare("UPDATE job_applications SET status = 'accepted' WHERE id = ?").run(app1.id);
  db.prepare("UPDATE jobs SET freelancer_id = ?, status = 'negotiating' WHERE id = ?").run(freelancerA.userId, job1);
  log(`   freelancerA accepted (application #${app1.id})`);

  // fund: buyer-signed real transaction
  const buyerKp = loadActorKp("demo_client.json");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({ fromPubkey: buyerKp.publicKey, toPubkey: new web3.PublicKey(esc1.address), lamports: lamports1 })
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = buyerKp.publicKey;
  tx.sign(buyerKp);
  const rawTx = tx.serialize();
  const claimedSig = bs58Of(tx);
  await fundEscrow({ id: job1, escrow_address: esc1.address, sol_lamports: lamports1, status: "created" }, rawTx, claimedSig);
  db.prepare("UPDATE jobs SET status = 'funded' WHERE id = ?").run(job1);
  log(`   ✅ FUNDED on-chain: ${claimedSig.slice(0, 20)}…`);
  log(`      https://explorer.solana.com/tx/${claimedSig}?cluster=devnet`);

  db.prepare("INSERT INTO negotiations (job_id, offer_by, price_sol, scope, deadline) VALUES (?, ?, ?, ?, ?)").run(
    job1,
    freelancerA.userId,
    lamports1 / 1e9,
    "90s launch video, motion graphics intro, velocity edits, captions. 5 days.",
    "2026-10-05"
  );
  db.prepare("UPDATE negotiations SET client_agreed = 1, freelancer_agreed = 1, status = 'agreed' WHERE job_id = ? AND status = 'proposed'").run(job1);
  db.prepare("UPDATE jobs SET status = 'agreed' WHERE id = ?").run(job1);
  db.prepare("INSERT INTO messages (job_id, sender_id, body) VALUES (?, ?, ?)").run(job1, client.userId, "Looking forward to it!");
  db.prepare("INSERT INTO deliveries (job_id, version, note, attachment_urls, submitted_by) VALUES (?, 1, ?, ?, ?)").run(
    job1,
    "v1: final cut + captions",
    JSON.stringify(["https://drive.example.com/launch_v1.mp4"]),
    freelancerA.userId
  );
  db.prepare("UPDATE jobs SET status = 'in_progress' WHERE id = ?").run(job1);
  db.prepare("UPDATE jobs SET status = 'delivered' WHERE id = ?").run(job1);

  const release = await releaseEscrow(job1, { escrow_address: esc1.address, freelancer_id: freelancerA.userId });
  db.prepare("UPDATE jobs SET status = 'released' WHERE id = ?").run(job1);
  db.prepare("INSERT INTO ratings (job_id, client_id, freelancer_id, stars, comment) VALUES (?, ?, ?, 5, 'Crushed it')").run(job1, client.userId, freelancerA.userId);
  log(`   ✅ RELEASED on-chain: ${release.signature.slice(0, 20)}… → ${freelancerA.wallet.slice(0, 8)}…`);
  log(`      https://explorer.solana.com/tx/${release.signature}?cluster=devnet`);

  // ---------------- ACT 2 — dispute + hold_buyer ruling + refund ----------------
  log("\n— Act 2: reject → escalate → support rules hold_buyer → client closes → refund —");
  const { id: job2, solLamports: lamports2 } = await insertJob({
    buyerId: client.userId,
    title: "Brand refresh: logo + social kit",
    requirements: "New logo, 5 social templates, brand one-pager.",
    usd: 80,
  });
  const esc2 = await initEscrow({ id: job2, escrow_address: null });
  db.prepare("INSERT INTO job_applications (job_id, freelancer_id, message) VALUES (?, ?, ?)").run(job2, freelancerB.userId, "Branding specialist, happy to start.");
  const app2 = db.prepare("SELECT id FROM job_applications WHERE job_id = ? AND freelancer_id = ?").get(job2, freelancerB.userId) as { id: number };
  db.prepare("UPDATE job_applications SET status = 'accepted' WHERE id = ?").run(app2.id);
  db.prepare("UPDATE jobs SET freelancer_id = ?, status = 'negotiating' WHERE id = ?").run(freelancerB.userId, job2);

  const tx2 = new web3.Transaction().add(
    web3.SystemProgram.transfer({ fromPubkey: buyerKp.publicKey, toPubkey: new web3.PublicKey(esc2.address), lamports: lamports2 })
  );
  const bh2 = await conn.getLatestBlockhash();
  tx2.recentBlockhash = bh2.blockhash;
  tx2.feePayer = buyerKp.publicKey;
  tx2.sign(buyerKp);
  await fundEscrow({ id: job2, escrow_address: esc2.address, sol_lamports: lamports2, status: "created" }, tx2.serialize(), bs58Of(tx2));
  db.prepare("UPDATE jobs SET status = 'funded' WHERE id = ?").run(job2);
  log(`   ✅ job #${job2} funded: ${lamports2 / 1e9} SOL into ${esc2.address.slice(0, 8)}…`);

  db.prepare("UPDATE jobs SET status = 'in_progress' WHERE id = ?").run(job2);
  db.prepare("INSERT INTO deliveries (job_id, version, note, attachment_urls, submitted_by) VALUES (?, 1, ?, ?, ?)").run(
    job2,
    "v1 drafts",
    JSON.stringify(["https://drive.example.com/brand_v1.zip"]),
    freelancerB.userId
  );
  db.prepare("UPDATE jobs SET status = 'delivered' WHERE id = ?").run(job2);
  db.prepare("UPDATE jobs SET status = 'rejected' WHERE id = ?").run(job2);
  audit({ actorId: client.userId, actionType: "job_rejected", targetEntity: "job", targetId: job2, beforeState: { status: "delivered" }, afterState: { status: "rejected", reason: "off-brief colors, missing one-pager" } });

  db.prepare("INSERT INTO disputes (job_id, raised_by, reason) VALUES (?, ?, ?)").run(job2, freelancerB.userId, "Work followed the brief; rejection unreasonable.");
  const d2 = db.prepare("SELECT id FROM disputes WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(job2) as { id: number };
  db.prepare("UPDATE jobs SET status = 'disputed' WHERE id = ?").run(job2);
  db.prepare("INSERT INTO helpdesk_tickets (user_id, job_id, dispute_id, subject) VALUES (?, ?, ?, ?)").run(
    freelancerB.userId,
    job2,
    d2.id,
    `Dispute #${d2.id}: job #${job2} "Brand refresh"`
  );
  log(`   dispute #${d2.id} opened; support rules…`);

  // support rules hold_buyer (no on-chain move; funds remain held)
  db.prepare("UPDATE disputes SET status = 'ruled', ruling = ?, ruled_by = ?, ruled_at = datetime('now') WHERE id = ?").run(
    JSON.stringify({ outcome: "hold_buyer", notes: "Deliverables off-brief; buyer rejection reasonable." }),
    support.userId,
    d2.id
  );
  db.prepare("UPDATE jobs SET status = 'held_detached', freelancer_id = NULL WHERE id = ?").run(job2);
  audit({ actorId: support.userId, actionType: "dispute_ruled", targetEntity: "dispute", targetId: d2.id, beforeState: { job_status: "disputed" }, afterState: { outcome: "hold_buyer", job_status: "held_detached" } });
  log(`   ruling: hold_buyer — funds stay locked in ${esc2.address.slice(0, 8)}…, freelancerB detached`);

  // client closes the held job → on-chain refund
  const refund = await refundEscrow(job2, { escrow_address: esc2.address, buyer_id: client.userId });
  db.prepare("UPDATE jobs SET status = 'closed_no_payout' WHERE id = ?").run(job2);
  log(`   ✅ REFUNDED on-chain: ${refund.signature.slice(0, 20)}… back to client`);
  log(`      https://explorer.solana.com/tx/${refund.signature}?cluster=devnet`);

  recomputeLeaderboard();
  await balances("after  ");
  const lb = db
    .prepare("SELECT u.wallet_address, l.score FROM leaderboard_scores l JOIN users u ON u.id = l.freelancer_id ORDER BY l.score DESC")
    .all();
  log("\n— Leaderboard —");
  for (const row of lb as { wallet_address: string; score: number }[]) log(`   ${row.wallet_address.slice(0, 8)}… score ${row.score}`);
  log("\nDemo story complete. Open http://localhost:8787 and use the quick-login buttons to walk each panel.\n");
}

function loadActorKp(file: string): web3.Keypair {
  const p = path.join(config.keysDir, file);
  const arr = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  return web3.Keypair.fromSecretKey(Uint8Array.from(arr));
}
function bs58Of(tx: web3.Transaction): string {
  const sig = tx.signatures[0]?.signature;
  if (!sig) throw new Error("tx not signed");
  return bs58.encode(sig);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
