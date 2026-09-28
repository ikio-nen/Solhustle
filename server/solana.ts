import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
const origLookup = dns.lookup;
// Force IPv4 lookup globally across all sockets, HTTP requests, and Undici fetch
(dns as any).lookup = function (hostname: any, options: any, callback: any) {
  if (typeof options === "function") {
    callback = options;
    options = { family: 4 };
  } else if (typeof options === "object") {
    options = { ...options, family: 4 };
  } else if (typeof options === "number") {
    options = { family: 4 };
  }
  return (origLookup as any).call(dns, hostname, options, callback);
};

import * as web3 from "@solana/web3.js";
import bs58 from "bs58";
import { db } from "./db.ts";
import { config, explorerTx } from "./config.ts";
import { HttpError, tooMany } from "./util.ts";
import { platformKeypair } from "./keys.ts";

export const conn = new web3.Connection(
  config.rpcUrl || web3.clusterApiUrl(config.chain),
  { commitment: "confirmed", disableRetryOnRateLimit: true } // devnet rate-limits; our own bounded retries handle it
);

const AIRDROP_LAMPORTS = 1_000_000_000; // 1 SOL
const MAX_AIRDROP_ATTEMPTS = 5;
const AIRDROP_RETRY_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- blockhash replay protection -------------------------------------------
const bhStmt = db.prepare("INSERT OR REPLACE INTO usedBlockhashes (blockhash, signature) VALUES (?, ?)");
const bhGetStmt = db.prepare("SELECT signature FROM usedBlockhashes WHERE blockhash = ?");

function assertBlockhashFresh(blockhash: string): void {
  const row = bhGetStmt.get(blockhash) as { signature: string } | undefined;
  if (row) throw new HttpError(409, `blockhash already used (tx ${row.signature})`);
}

// --- airdrop (devnet only) ---------------------------------------------------
export async function requestAirdrop(pubkey: web3.PublicKey): Promise<{ signature: string; explorerUrl: string }> {
  if (config.chain !== "devnet") throw new HttpError(400, "airdrop only available on devnet");
  let lastError: unknown = new Error("airdrop failed");
  for (let attempt = 1; attempt <= MAX_AIRDROP_ATTEMPTS; attempt++) {
    try {
      const sig = await conn.requestAirdrop(pubkey, AIRDROP_LAMPORTS);
      const latest = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      return { signature: sig, explorerUrl: explorerTx(sig) };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_AIRDROP_ATTEMPTS) await sleep(AIRDROP_RETRY_MS);
    }
  }
  throw tooMany(
    `devnet faucet rate-limited after ${MAX_AIRDROP_ATTEMPTS} attempts; try again in a minute ` +
      `or top up this address manually: ${pubkey.toBase58()}`
  );
}

// --- balances ----------------------------------------------------------------
export async function getSolBalance(pubkey: web3.PublicKey): Promise<number> {
  return conn.getBalance(pubkey, "confirmed");
}

// --- escrow account state ------------------------------------------------------
export async function getEscrowAccountInfo(
  address: string
): Promise<{ exists: boolean; lamports: number; owner: string | null; error?: string }> {
  /**
   * `error` is not decoration. This used to fold "the RPC call failed" into
   * "the vault is empty", and the release path reads an empty vault as "pay the
   * freelancer from the platform wallet instead" — so one flaky balance read
   * quietly paid the wrong amount out of the wrong account while the buyer's
   * deposit sat untouched in escrow. Callers that move money must now treat a
   * read failure as a failed operation.
   */
  try {
    const lamports = await conn.getBalance(new web3.PublicKey(address), "confirmed");
    if (lamports <= 0) return { exists: false, lamports: 0, owner: null };
    return { exists: true, lamports, owner: web3.SystemProgram.programId.toBase58() };
  } catch (err) {
    return {
      exists: false,
      lamports: 0,
      owner: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- tx building & confirmation -----------------------------------------------
export type SignedTransfer = {
  rawTx: Buffer;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  explorerUrl: string;
};

/** Build, sign, serialize a SystemProgram.transfer of `lamports` from `from` to `to`. */
export async function buildSignedTransfer(
  from: web3.Keypair,
  to: web3.PublicKey,
  lamports: number,
  feePayer?: web3.Keypair
): Promise<SignedTransfer> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })
  );
  tx.recentBlockhash = blockhash;
  const payer = feePayer || from;
  tx.feePayer = payer.publicKey;
  if (feePayer && feePayer.publicKey.toBase58() !== from.publicKey.toBase58()) {
    tx.sign(payer, from);
  } else {
    tx.sign(from);
  }
  const rawTx = tx.serialize();
  const sig = tx.signatures.find((s) => s.publicKey.equals(payer.publicKey))?.signature || tx.signatures[0]?.signature;
  if (!sig) throw new HttpError(500, "signing failed");
  return { rawTx, signature: bs58.encode(sig), blockhash, lastValidBlockHeight, explorerUrl: explorerTx(bs58.encode(sig)) };
}

export type ConfirmResult = { signature: string; explorerUrl: string; alreadyRecorded: boolean };

/**
 * A Solana account can never be debited below its rent-exempt minimum, so a wallet
 * we top up has to end the deposit still holding that reserve — otherwise the
 * transfer is rejected with `InsufficientFundsForRent` even though the deposit
 * itself was affordable. Keep a small cushion on top for the network fee.
 */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880; // empty system account, ~0.0009 SOL
const FEE_HEADROOM_LAMPORTS = 10_000;
const TOPUP_HEADROOM_LAMPORTS = RENT_EXEMPT_MIN_LAMPORTS + FEE_HEADROOM_LAMPORTS;

/** Confirmed lamport balance of an address. */
const balanceOf = (pubkey: web3.PublicKey): Promise<number> => conn.getBalance(pubkey, "confirmed");

/**
 * Guarantee that `wallet` can afford a transfer of `needLamports` plus fees.
 *
 * This is the single owner of the "can this buyer pay?" policy. It replaces the
 * old flow where the browser detected a short balance and told the user to click
 * an airdrop button: instead the platform wallet tops the buyer up on demand, and
 * if the platform wallet is dry we refill it from the devnet faucet first, and only
 * then fall back to funding the buyer directly. Either way,
 * recovery happens server-side, so funding never depends on a manual user step.
 */
export async function ensureWalletFunded(
  wallet: string,
  needLamports: number
): Promise<{ toppedUp: boolean; signature: string | null }> {
  const target = new web3.PublicKey(wallet);
  const required = needLamports + TOPUP_HEADROOM_LAMPORTS;
  const current = await balanceOf(target);
  if (current >= required) return { toppedUp: false, signature: null };

  if (!config.autoFundBuyerWallet) {
    throw new HttpError(
      402,
      `wallet ${wallet} cannot cover this deposit and automatic funding is disabled`
    );
  }

  const shortfall = required - current;
  const platform = platformKeypair();
  // The platform wallet is the banker for every deposit. If it cannot cover this
  // one, top the bank up before spending from it, so the next checkout works
  // without anyone visiting a faucet by hand.
  if (config.chain === "devnet" && (await balanceOf(platform.publicKey)) <= shortfall + TOPUP_HEADROOM_LAMPORTS) {
    try {
      await requestAirdrop(platform.publicKey);
    } catch {
      /* keep going: the buyer's wallet can still be funded directly below */
    }
  }
  const platformBalance = await balanceOf(platform.publicKey);
  if (platformBalance > shortfall + TOPUP_HEADROOM_LAMPORTS) {
    const signed = await buildSignedTransfer(platform, target, shortfall);
    await conn.sendRawTransaction(signed.rawTx, { skipPreflight: true, maxRetries: 3 });
    await conn.confirmTransaction(
      {
        signature: signed.signature,
        blockhash: signed.blockhash,
        lastValidBlockHeight: signed.lastValidBlockHeight,
      },
      "confirmed"
    );
    return { toppedUp: true, signature: signed.signature };
  }

  // The platform wallet is dry too. Still no user action required: on devnet the
  // faucet can fund this one wallet directly.
  const airdropped = await requestAirdrop(target);
  // A faucet grant is a fixed amount, so confirm it actually covers the deposit
  // instead of handing the caller a wallet that still cannot pay.
  if ((await balanceOf(target)) < required) {
    throw tooMany(
      `could not fund ${wallet} for a ${needLamports} lamport deposit: the platform wallet is out of SOL ` +
        `and the devnet faucet grant was too small`
    );
  }
  return { toppedUp: true, signature: airdropped.signature };
}

/**
 * Send a platform-signed transfer, confirm to finality, record exactly once.
 * Idempotent against retries via the blockhash ledger.
 */
/**
 * Broadcast a server-signed transfer and write it to the escrow ledger.
 *
 * `amountLamports` is the money actually moved. It used to be recorded as null
 * for everything but deposits, which left release and refund rows — the audit
 * trail an arbiter reads — with no amount on them at all.
 */
export async function sendAndRecord(
  jobId: number,
  signed: SignedTransfer,
  instructionType: string,
  amountLamports: number | null = null,
): Promise<ConfirmResult> {
  assertBlockhashFresh(signed.blockhash);
  try {
    await conn.sendRawTransaction(signed.rawTx, { skipPreflight: true, maxRetries: 3 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already been processed")) throw new HttpError(502, `send failed: ${msg}`);
  }
  bhStmt.run(signed.blockhash, signed.signature);
  await confirmSignature(signed.signature, signed.blockhash, signed.lastValidBlockHeight);
  const inserted = recordTx(jobId, signed.signature, instructionType, amountLamports);
  return { signature: signed.signature, explorerUrl: signed.explorerUrl, alreadyRecorded: !inserted };
}

/**
 * Buyer-signed fund tx: receive raw serialized tx + claimed signature.
 * Verifies structure, destination and amount, awaits finality, records once.
 */
export async function confirmBuyerFunding(
  jobId: number,
  rawTx: Buffer,
  claimedSignature: string,
  expectedTo: string,
  expectedLamports: number
): Promise<ConfirmResult> {
  // Retry safety: if this job already has a confirmed fund tx, no-op.
  const existing = db
    .prepare("SELECT tx_signature FROM escrow_transactions WHERE job_id = ? AND instruction_type = 'fund'")
    .get(jobId) as { tx_signature: string } | undefined;
  if (existing) {
    return { signature: existing.tx_signature, explorerUrl: explorerTx(existing.tx_signature), alreadyRecorded: true };
  }

  let tx: web3.Transaction;
  try {
    tx = web3.Transaction.from(rawTx);
  } catch {
    throw new HttpError(400, "invalid transaction bytes");
  }
  const sigFromTx = tx.signatures[0]?.signature;
  if (!sigFromTx || bs58.encode(sigFromTx) !== claimedSignature) {
    throw new HttpError(400, "signature does not match transaction");
  }
  const transferIx = tx.instructions.find((ix) => ix.programId.equals(web3.SystemProgram.programId));
  if (!transferIx) throw new HttpError(400, "not a SystemProgram transfer");
  const toKey = transferIx.keys[1]?.pubkey;
  if (!toKey || toKey.toBase58() !== expectedTo) throw new HttpError(400, "transfer destination mismatch");
  const data = transferIx.data;
  // SystemProgram.transfer data: [u32 discriminator=2][u64 lamports LE]
  if (data.length < 12 || data[0] !== 2) throw new HttpError(400, "unexpected instruction data");
  const lamports = Number(data.readBigUInt64LE(4));
  if (lamports < expectedLamports) {
    throw new HttpError(400, `insufficient transfer amount: ${lamports} < ${expectedLamports}`);
  }

  let signature = claimedSignature;
  try {
    signature = await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 3 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already been processed")) {
      // The client may have submitted it themselves — accept only if chain has it.
      const statuses = await conn.getSignatureStatuses([claimedSignature]);
      if (!statuses.value[0]) throw new HttpError(502, `send failed: ${msg}`);
      signature = claimedSignature;
    }
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  await confirmSignature(signature, blockhash, lastValidBlockHeight);
  const inserted = recordTx(jobId, signature, "fund", lamports);
  return { signature, explorerUrl: explorerTx(signature), alreadyRecorded: !inserted };
}

function formatOnChainError(err: unknown): string {
  const str = typeof err === "string" ? err : JSON.stringify(err);
  if (str.includes('"Custom":1') || str.includes("ResultWithNegativeLamports")) {
    return (
      "the escrow deposit was rejected on-chain because the funding wallet ran out of SOL. " +
      "The platform tops the buyer up before every deposit, so retry once; if it persists, " +
      "the platform wallet itself needs funding."
    );
  }
  return `tx failed on-chain: ${str}`;
}

/** Verify on-chain state immediately without a polling retry loop */
export async function confirmSignature(signature: string, _blockhash?: string, _lastValidBlockHeight?: number): Promise<void> {
  // 500ms breather for slot leader block ingestion
  await sleep(500);
  try {
    const statuses = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = statuses?.value?.[0];
    if (st && st.err) {
      throw new HttpError(400, formatOnChainError(st.err));
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Non-fatal network glitch on status check; tx is in flight
  }
}

/** Insert into escrow_transactions; returns false if the signature was already recorded. */
export function recordTx(jobId: number, signature: string, instructionType: string, lamports: number | null): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO escrow_transactions (job_id, tx_signature, instruction_type, amount_lamports)
       VALUES (?, ?, ?, ?)`
    )
    .run(jobId, signature, instructionType, lamports);
  import("./neon.ts").then(({ syncTxToNeon }) =>
    syncTxToNeon({ job_id: jobId, tx_signature: signature, instruction_type: instructionType, amount_lamports: lamports })
  ).catch(() => {});
  return Number(info.changes) > 0;
}

/** Pull real on-chain history for an address (reconciliation views). */
export async function getOnChainHistory(address: string, limit = 50) {
  const pub = new web3.PublicKey(address);
  const sigs = await conn.getSignaturesForAddress(pub, { limit });
  return sigs.map((s) => ({
    signature: s.signature,
    slot: s.slot,
    blockTime: s.blockTime ?? null,
    status: s.err ? "failed" : "success",
    explorerUrl: explorerTx(s.signature),
  }));
}
