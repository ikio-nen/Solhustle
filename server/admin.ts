import { db } from "./db.ts";
import { conn } from "./solana.ts";
import { reconcileAllJobs } from "./escrow.ts";
import { listAudit, audit } from "./audit.ts";
import { bad, parseIntOr } from "./util.ts";
import { h } from "./util.ts";
import { explorerAccount } from "./config.ts";

/** Dev role: system health. Support role: dispute queue (in disputes.ts). Both: audit. */
export const healthRoute = h(async (_req, res) => {
  let rpc: unknown = { ok: false, error: "unreachable" };
  try {
    const slot = await conn.getSlot("finalized");
    const version = await conn.getVersion();
    rpc = { ok: true, slot, solanaVersion: version["solana-core"], endpoint: conn.rpcEndpoint };
  } catch (err) {
    rpc = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const counts = {
    users: (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n,
    jobs: (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
    disputes_open: (db.prepare("SELECT COUNT(*) AS n FROM disputes WHERE status = 'open'").get() as { n: number }).n,
    tickets_open: (db.prepare("SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE status = 'open'").get() as { n: number }).n,
    escrow_txs: (db.prepare("SELECT COUNT(*) AS n FROM escrow_transactions").get() as { n: number }).n,
  };
  res.json({ chain: process.env.CHAIN || "devnet", rpc, counts, time: new Date().toISOString() });
});

export const reconciliationRoute = h(async (_req, res) => {
  res.json({ reconciliations: await reconcileAllJobs() });
});

export const auditRoute = h(async (req, res) => {
  const limit = req.query.limit !== undefined ? Math.min(parseIntOr(req.query.limit, "limit"), 500) : 200;
  res.json({ actions: listAudit(limit) });
});

// --- user management (support + dev) ------------------------------------------
type ActivityRow = Record<string, unknown>;

export const listUsers = h(async (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.wallet_address, u.role, u.status, u.created_at,
              cp.organization,
              (SELECT COUNT(*) FROM jobs j WHERE j.buyer_id = u.id) AS jobs_posted,
              (SELECT COUNT(*) FROM jobs j WHERE j.freelancer_id = u.id) AS jobs_taken,
              (SELECT COUNT(*) FROM jobs j WHERE j.freelancer_id = u.id AND j.status = 'released') AS jobs_completed,
              (SELECT COUNT(*) FROM job_applications a WHERE a.freelancer_id = u.id) AS applications_sent,
              (SELECT COUNT(*) FROM disputes d WHERE d.raised_by = u.id) AS disputes_raised,
              (SELECT COUNT(*) FROM helpdesk_tickets t WHERE t.user_id = u.id) AS tickets_opened,
              (SELECT COUNT(*) FROM ticket_replies r WHERE r.sender_id = u.id) AS ticket_replies,
              (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS messages_sent,
              (SELECT COALESCE(SUM(t.amount_lamports),0) FROM escrow_transactions t
                 JOIN jobs j2 ON j2.id = t.job_id
                WHERE t.instruction_type = 'fund' AND j2.buyer_id = u.id) AS sol_funded_lamports,
              (SELECT COALESCE(SUM(r.stars),0) FROM ratings r WHERE r.freelancer_id = u.id) AS stars_earned,
              (SELECT COUNT(*) FROM ratings r WHERE r.freelancer_id = u.id) AS ratings_received
       FROM users u
       LEFT JOIN client_profiles cp ON cp.user_id = u.id
       ORDER BY u.id`
    )
    .all() as ActivityRow[];
  res.json({ users });
});

export const setUserStatus = h(async (req, res) => {
  const actor = req.user!;
  const id = parseIntOr(req.params.id, "user id");
  if (id === actor.id) throw bad("cannot change your own status");
  const status = requireStringStatic(req.body, "status");
  if (status !== "active" && status !== "suspended") throw bad("status must be active or suspended");
  const target = db.prepare("SELECT id, status FROM users WHERE id = ?").get(id) as { id: number; status: string } | undefined;
  if (!target) throw bad("user not found");
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
  audit({
    actorId: actor.id,
    actionType: "user_status_changed",
    targetEntity: "user",
    targetId: id,
    beforeState: { status: target.status },
    afterState: { status },
  });
  res.json({ ok: true, user: { id, status } });
});

export const userDetail = h(async (req, res) => {
  const id = parseIntOr(req.params.id, "user id");
  const user = db.prepare("SELECT id, wallet_address, role, status, created_at FROM users WHERE id = ?").get(id) as
    | { id: number; wallet_address: string }
    | undefined;
  if (!user) throw bad("user not found");
  const jobs = db
    .prepare(
      `SELECT id, title, status, usd_budget, round,
              CASE WHEN buyer_id = ? THEN 'posted' ELSE 'taken' END AS relation
       FROM jobs WHERE buyer_id = ? OR freelancer_id = ? ORDER BY id DESC`
    )
    .all(id, id, id);
  const disputes = db.prepare("SELECT id, job_id, status, ruling FROM disputes WHERE raised_by = ? OR ruled_by = ?").all(id, id);
  const tickets = db.prepare("SELECT id, subject, status FROM helpdesk_tickets WHERE user_id = ?").all(id);
  const escrow = db
    .prepare(
      `SELECT t.tx_signature, t.instruction_type, t.amount_lamports, t.confirmed_at, j.id AS job_id
       FROM escrow_transactions t JOIN jobs j ON j.id = t.job_id
       WHERE j.buyer_id = ? OR j.freelancer_id = ? ORDER BY t.id DESC`
    )
    .all(id, id)
    .map((t: Record<string, unknown>) => ({
      ...t,
      explorer_url: explorerAccount(String(t.tx_signature)).replace("/account/", "/tx/"),
    }));
  res.json({ user, jobs, disputes, tickets, escrow_transactions: escrow });
});

function requireStringStatic(body: unknown, field: string): string {
  const v = (body as Record<string, unknown>)?.[field];
  if (typeof v !== "string" || v.trim() === "") throw bad(`${field} is required`);
  return v.trim();
}
