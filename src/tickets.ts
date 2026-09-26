import { db } from "./db.ts";
import { bad, notFound, parseIntOr, requireString } from "./util.ts";
import { h } from "./util.ts";
import { audit } from "./audit.ts";

export const createTicket = h(async (req, res) => {
  const user = req.user!;
  const subject = requireString(req.body ?? {}, "subject", 200);
  const jobId = req.body?.job_id !== undefined ? Number(req.body.job_id) : null;
  const body = requireString(req.body ?? {}, "body", 4000);
  if (jobId !== null && (!Number.isInteger(jobId) || jobId <= 0)) throw bad("invalid job_id");
  db.prepare("INSERT INTO helpdesk_tickets (user_id, job_id, subject) VALUES (?, ?, ?)").run(user.id, jobId, subject);
  const ticket = db.prepare("SELECT * FROM helpdesk_tickets ORDER BY id DESC LIMIT 1").get() as { id: number };
  db.prepare("INSERT INTO ticket_replies (ticket_id, sender_id, body, is_staff) VALUES (?, ?, ?, 0)").run(ticket.id, user.id, body);
  res.status(201).json({ ticket: ticket.id });
});

export const listTickets = h(async (req, res) => {
  const user = req.user!;
  const rows =
    user.role === "support" || user.role === "dev"
      ? (db.prepare(
          `SELECT t.*, u.wallet_address, u.role AS user_role
           FROM helpdesk_tickets t JOIN users u ON u.id = t.user_id
           ORDER BY (t.status = 'open') DESC, t.id DESC`
        ).all() as unknown[])
      : (db.prepare(
          `SELECT t.*, u.wallet_address, u.role AS user_role
           FROM helpdesk_tickets t JOIN users u ON u.id = t.user_id
           WHERE t.user_id = ? ORDER BY (t.status = 'open') DESC, t.id DESC`
        ).all(user.id) as unknown[]);
  res.json({ tickets: rows });
});

export const getTicket = h(async (req, res) => {
  const user = req.user!;
  const id = parseIntOr(req.params.id, "ticket id");
  const t = db.prepare("SELECT * FROM helpdesk_tickets WHERE id = ?").get(id) as { id: number; user_id: number; status: string } | undefined;
  if (!t) throw notFound("ticket not found");
  if (t.user_id !== user.id && user.role !== "support" && user.role !== "dev") throw notFound("ticket not found");
  const replies = db
    .prepare(
      `SELECT r.*, u.wallet_address, u.role AS sender_role
       FROM ticket_replies r JOIN users u ON u.id = r.sender_id WHERE r.ticket_id = ? ORDER BY r.id`
    )
    .all(id);
  res.json({ ticket: t, replies });
});

export const replyTicket = h(async (req, res) => {
  const user = req.user!;
  const id = parseIntOr(req.params.id, "ticket id");
  const t = db.prepare("SELECT * FROM helpdesk_tickets WHERE id = ?").get(id) as { id: number; user_id: number; status: string } | undefined;
  if (!t) throw notFound("ticket not found");
  const isStaff = user.role === "support" || user.role === "dev";
  if (t.user_id !== user.id && !isStaff) throw notFound("ticket not found");
  const body = requireString(req.body ?? {}, "body", 4000);
  db.prepare("INSERT INTO ticket_replies (ticket_id, sender_id, body, is_staff) VALUES (?, ?, ?, ?)").run(
    id,
    user.id,
    body,
    isStaff ? 1 : 0
  );
  db.prepare("UPDATE helpdesk_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
    isStaff ? "answered" : "open",
    id
  );
  res.json({ ok: true });
});

export const resolveTicket = h(async (req, res) => {
  const user = req.user!;
  const id = parseIntOr(req.params.id, "ticket id");
  const t = db.prepare("SELECT * FROM helpdesk_tickets WHERE id = ?").get(id) as { id: number; user_id: number } | undefined;
  if (!t) throw notFound("ticket not found");
  const isStaff = user.role === "support" || user.role === "dev";
  if (t.user_id !== user.id && !isStaff) throw notFound("ticket not found");
  db.prepare("UPDATE helpdesk_tickets SET status = 'resolved', updated_at = datetime('now') WHERE id = ?").run(id);
  audit({
    actorId: user.id,
    actionType: "ticket_resolved",
    targetEntity: "helpdesk_ticket",
    targetId: id,
    afterState: { status: "resolved" },
  });
  res.json({ ok: true });
});
