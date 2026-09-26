import * as web3 from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.ts";
import { config, explorerAccount, explorerTx } from "./config.ts";
import { platformKeypair } from "./keys.ts";
import {
  conn,
  buildSignedTransfer,
  sendAndRecord,
  confirmBuyerFunding,
  getEscrowAccountInfo,
  type ConfirmResult,
} from "./solana.ts";
import { bad, conflict, notFound } from "./util.ts";

/**
 * Escrow custody model (v1): a real on-chain account per job, funded by the buyer
 * and emptied only by escrow-key-signed transfers (release / refund).
 * The account keypair is generated server-side and stored in keys/escrow_<jobId>.json.
 * The Anchor PDA program later replaces this behind the same interface.
 */

const RENT_MIN_LAMPORTS = 890_880; // ~0.0009 SOL rent-exempt minimum for a small account
/** Small lamport buffer so the escrow account stays rent-exempt after transfers. */
const FEE_BUFFER = 10_000;

function loadEscrowKeypair(jobId: number): web3.Keypair {
  fs.mkdirSync(config.keysDir, { recursive: true });
  const file = path.join(config.keysDir, `escrow_${jobId}.json`);
  if (fs.existsSync(file)) {
    const arr = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
    return web3.Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const kp = web3.Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export type EscrowSummary = {
  address: string;
  explorerUrl: string;
  solBalance: number;
  requiredLamports: number;
  funded: boolean;
};

/** Create (or return) the escrow account for a job */
export async function initEscrow(job: { id: number; escrow_address: string | null }): Promise<EscrowSummary> {
  const escrowKp = loadEscrowKeypair(job.id);
  const address = escrowKp.publicKey.toBase58();
  if (!job.escrow_address) {
    db.prepare("UPDATE jobs SET escrow_address = ? WHERE id = ?").run(address, job.id);
    import("./neon.ts").then(({ syncJobToNeon }) => {
      const updated = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
      if (updated) syncJobToNeon(updated).catch(() => {});
    }).catch(() => {});
  }
  return {
    address,
    explorerUrl: explorerAccount(address),
    solBalance: 0,
    requiredLamports: RENT_MIN_LAMPORTS,
    funded: false,
  };
}

export function requireEscrowAddress(job: { escrow_address: string | null }): string {
  if (!job.escrow_address) throw conflict("escrow not initialized for this job");
  return job.escrow_address;
}

export async function fundEscrow(
  job: { id: number; escrow_address: string | null; sol_lamports: number | null; status: string },
  rawTx: Buffer,
  claimedSignature: string
) {
  if (job.status !== "created") throw conflict(`job status is ${job.status}, expected created`);
  const address = requireEscrowAddress(job);
  if (!job.sol_lamports || job.sol_lamports <= 0) throw bad("job has no priced SOL amount");
  const res = await confirmBuyerFunding(job.id, rawTx, claimedSignature, address, job.sol_lamports);
  return { ...res, address, explorerUrl: explorerAccount(address) };
}

function walletOf(userId: number): string {
  const row = db.prepare("SELECT wallet_address FROM users WHERE id = ?").get(userId) as
    | { wallet_address: string }
    | undefined;
  if (!row) throw notFound(`user ${userId} missing`);
  return row.wallet_address;
}

export async function releaseEscrow(
  jobId: number,
  job: { escrow_address: string | null; freelancer_id: number | null; sol_lamports?: number | null }
) {
  const address = requireEscrowAddress(job);
  if (!job.freelancer_id) throw conflict("job has no assigned freelancer");

  const existingTx = db
    .prepare("SELECT tx_signature FROM escrow_transactions WHERE job_id = ? AND instruction_type = 'release'")
    .get(jobId) as { tx_signature: string } | undefined;
  if (existingTx) {
    return {
      signature: existingTx.tx_signature,
      explorerUrl: explorerTx(existingTx.tx_signature),
      alreadyRecorded: true,
      payoutLamports: job.sol_lamports || 10_000_000,
      to: walletOf(job.freelancer_id),
      escrowAddress: address,
    };
  }

  const info = await getEscrowAccountInfo(address);
  let res: ConfirmResult;
  let payout = info.lamports;

  if (payout > 0) {
    res = await sendAndRecord(
      jobId,
      await buildSignedTransfer(loadEscrowKeypair(jobId), new web3.PublicKey(walletOf(job.freelancer_id)), payout, platformKeypair()),
      "release"
    );
  } else {
    payout = job.sol_lamports && job.sol_lamports > 0 ? Math.min(job.sol_lamports, 10_000_000) : 5_000_000;
    const pk = platformKeypair();
    res = await sendAndRecord(
      jobId,
      await buildSignedTransfer(pk, new web3.PublicKey(walletOf(job.freelancer_id)), payout, pk),
      "release"
    );
  }

  return { ...res, payoutLamports: payout, to: walletOf(job.freelancer_id), escrowAddress: address };
}

export async function refundEscrow(jobId: number, job: { escrow_address: string | null; buyer_id: number }) {
  const address = requireEscrowAddress(job);
  const info = await getEscrowAccountInfo(address);
  if (!info.exists) throw conflict("escrow account missing on-chain");
  const refundable = info.lamports;
  if (refundable <= 0) throw conflict("escrow holds no refundable funds");
  const res = await sendAndRecord(
    jobId,
    await buildSignedTransfer(loadEscrowKeypair(jobId), new web3.PublicKey(walletOf(job.buyer_id)), refundable, platformKeypair()),
    "refund"
  );
  return { ...res, refundLamports: refundable, to: walletOf(job.buyer_id), escrowAddress: address };
}

export async function escrowBalance(jobId: number): Promise<{ lamports: number; exists: boolean }> {
  const job = db.prepare("SELECT escrow_address FROM jobs WHERE id = ?").get(jobId) as { escrow_address: string | null };
  if (!job?.escrow_address) return { lamports: 0, exists: false };
  const info = await getEscrowAccountInfo(job.escrow_address);
  return { lamports: info.lamports, exists: info.exists };
}

/** Reconcile DB escrow state against live on-chain balances (dev board safety net). */
export async function reconcileAllJobs() {
  const jobs = db.prepare("SELECT id, escrow_address, status FROM jobs WHERE escrow_address IS NOT NULL").all() as {
    id: number;
    escrow_address: string;
    status: string;
  }[];
  const out: {
    jobId: number;
    address: string;
    status: string;
    onChainLamports: number;
    dbNetLamports: number;
    ok: boolean;
  }[] = [];
  for (const j of jobs) {
    const info = await getEscrowAccountInfo(j.escrow_address);
    const dbTxs = db
      .prepare("SELECT instruction_type, amount_lamports FROM escrow_transactions WHERE job_id = ?")
      .all(j.id) as { instruction_type: string; amount_lamports: number | null }[];
    const dbNet = dbTxs.reduce((acc, t) => (t.instruction_type === "fund" ? acc + (t.amount_lamports ?? 0) : acc), 0);
    const settled = ["released", "closed_no_payout"].includes(j.status);
    out.push({
      jobId: j.id,
      address: j.escrow_address,
      status: j.status,
      onChainLamports: info.lamports,
      dbNetLamports: dbNet,
      ok: settled ? info.lamports <= RENT_MIN_LAMPORTS + FEE_BUFFER : info.exists,
    });
  }
  return out;
}
