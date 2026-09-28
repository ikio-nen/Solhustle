import { db } from "./db.ts";
import { bad, conflict, forbidden, notFound, parseIntOr, requireString } from "./util.ts";
import { h } from "./util.ts";
import { getJob, touchJobSafe } from "./jobs-helpers.ts";
import { releaseEscrow } from "./escrow.ts";
import { audit } from "./audit.ts";

/**
 * Support ruling flow:
 * - release_freelancer → same as approval, fired by the arbiter path: on-chain release.
 * - hold_buyer → funds stay held on-chain; freelancer detached; job re-listed later
 *   (buyer can close → on-chain refund anytime while held).
 */

export const listDisputes = h(async (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.*, j.title AS job_title, j.status AS job_status, j.escrow_address,
              ur.wallet_address AS raised_by_wallet,
              ru.wallet_address AS ruled_by_wallet
       FROM disputes d
       JOIN jobs j ON j.id = d.job_id
       JOIN users ur ON ur.id = d.raised_by
       LEFT JOIN users ru ON ru.id = d.ruled_by
       ORDER BY (d.status = 'open') DESC, d.id DESC`
    )
    .all();
  res.json({ disputes: rows });
});

export const getDispute = h(async (req, res) => {
  const id = parseIntOr(req.params.id, "dispute id");
  const d = db.prepare("SELECT * FROM disputes WHERE id = ?").get(id) as { id: number; job_id: number; status: string; ruling: string | null; ruled_by: number | null } | undefined;
  if (!d) throw notFound("dispute not found");
  const evidence = await disputeEvidence(d.job_id);
  res.json({ dispute: d, evidence });
});

export const ruleDispute = h(async (req, res) => {
  const user = req.user!;
  if (user.role !== "support" && user.role !== "dev") throw forbidden("support or dev only");
  const id = parseIntOr(req.params.id, "dispute id");
  const d = db.prepare("SELECT * FROM disputes WHERE id = ?").get(id) as
    | { id: number; job_id: number; status: string; ruling: string | null }
    | undefined;
  if (!d) throw notFound("detached dispute not found");
  if (d.status !== "open") throw conflict("dispute already ruled");
  const outcome = requireString(req.body ?? {}, "outcome", 40);
  if (outcome !== "release_freelancer" && outcome !== "hold_buyer") {
    throw bad("outcome must be release_freelancer or hold_buyer");
  }
  const notes = requireString(req.body ?? {}, "notes", 3000);
  const job = getJob(d.job_id);
  if (job.status !== "disputed") throw conflict(`job status is ${job.status}, expected disputed`);

  let chainResult: unknown = null;
  if (outcome === "release_freelancer") {
    chainResult = await releaseEscrow(job.id, job);
    touchJobSafe(job.id, { status: "released" });
  } else {
    // Funds remain held in the escrow account; freelancer detached.
    touchJobSafe(job.id, { status: "held_detached", freelancer_id: null });
  }

  db.prepare("UPDATE disputes SET status = 'ruled', ruling = ?, ruled_by = ?, ruled_at = datetime('now') WHERE id = ?").run(
    JSON.stringify({ outcome, notes }),
    user.id,
    id
  );
  audit({
    actorId: user.id,
    actionType: "dispute_ruled",
    targetEntity: "dispute",
    targetId: id,
    beforeState: { dispute: "open", job_status: "disputed" },
    afterState: { outcome, notes, job_status: outcome === "release_freelancer" ? "released" : "held_detached" },
  });
  // Resolve the auto-opened ticket, if any.
  db.prepare("UPDATE helpdesk_tickets SET status = 'resolved', updated_at = datetime('now') WHERE dispute_id = ? AND status != 'resolved'").run(id);
  res.json({ ok: true, outcome, chainResult, job: getJob(job.id) });
});

/** Full evidence bundle for a support reviewer. */
export async function disputeEvidence(jobId: number) {
  const job = getJob(jobId);
  const negotiation = db.prepare("SELECT * FROM negotiations WHERE job_id = ? ORDER BY id").all(jobId);
  const messages = db.prepare("SELECT * FROM messages WHERE job_id = ? ORDER BY id").all(jobId);
  const deliveries = db.prepare("SELECT * FROM deliveries WHERE job_id = ? ORDER BY version").all(jobId);
  const txs = db
    .prepare("SELECT * FROM escrow_transactions WHERE job_id = ? ORDER BY id")
    .all(jobId)
    .map((t: Record<string, unknown>) => ({ ...t, explorer_url: `https://explorer.solana.com/tx/${String(t.tx_signature)}?cluster=devnet` }));
  const buyer = db
    .prepare("SELECT u.wallet_address, cp.organization FROM users u LEFT JOIN client_profiles cp ON cp.user_id = u.id WHERE u.id = ?")
    .get(job.buyer_id);
  const freelancer = job.freelancer_id
    ? db.prepare("SELECT u.wallet_address, fp.headline FROM users u LEFT JOIN freelancer_profiles fp ON fp.user_id = u.id WHERE u.id = ?").get(job.freelancer_id)
    : null;
  return { job, buyer, freelancer, negotiation, messages, deliveries, escrow_transactions: txs };
}
