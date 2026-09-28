/**
 * Direct messages — the person-to-person half of messaging.
 *
 * `jobs.ts` owns the *contract* thread: messages attached to one job, visible to
 * whoever is party to that job. This module owns chat between two accounts, so a
 * client can reach a freelancer before there is a job, and the conversation
 * survives the job being cancelled.
 *
 * Access control is membership, never a request field: every handler resolves the
 * thread through `conversation_members` for the caller's own id and answers 404
 * for anything else, so a guessed thread id reveals nothing (no 403, which would
 * confirm the thread exists).
 */
import { db, getUser, type User } from "./db.ts";
import { bad, notFound, requireString, h } from "./util.ts";
import { demoActorLabel } from "./seed.ts";

/** Longest single message. Kept in step with the composer's counter client-side. */
export const MAX_MESSAGE_LEN = 2000;
/** Most recent messages returned for one thread. */
const PAGE_SIZE = 200;

export type OtherPerson = {
  id: number;
  /** Username when the account has password credentials, else a short wallet. */
  name: string;
  username: string | null;
  role: string;
  wallet_address: string;
  headline: string | null;
};

type PersonRow = {
  id: number;
  role: string;
  status: string;
  wallet_address: string;
  username: string | null;
  headline: string | null;
};

const shortWallet = (wallet: string) => `${wallet.slice(0, 8)}…`;

function person(userId: number): OtherPerson | null {
  const row = db
    .prepare(
      `SELECT u.id, u.role, u.status, u.wallet_address,
              c.username AS username,
              fp.headline AS headline
         FROM users u
         LEFT JOIN user_credentials c ON c.user_id = u.id
         LEFT JOIN freelancer_profiles fp ON fp.user_id = u.id
        WHERE u.id = ?`,
    )
    .get(userId) as PersonRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.username || demoActorLabel(row.wallet_address) || shortWallet(row.wallet_address),
    username: row.username,
    role: row.role,
    wallet_address: row.wallet_address,
    headline: row.headline,
  };
}

/** The other member of a two-party thread, or null if it is not two-party. */
function otherMember(conversationId: number, userId: number): OtherPerson | null {
  const row = db
    .prepare(
      "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?",
    )
    .get(conversationId, userId) as { user_id: number } | undefined;
  return row ? person(row.user_id) : null;
}

/** Membership check used by every read and write below. */
function assertMember(conversationId: number, userId: number): void {
  const row = db
    .prepare("SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
    .get(conversationId, userId) as { ok: number } | undefined;
  // Deliberately a 404 and not a 403: a stranger must not learn that the thread
  // exists at all.
  if (!row) throw notFound("conversation not found");
}

type MessageRow = { id: number; sender_id: number; body: string; created_at: string };

function publicMessage(row: MessageRow, meId: number) {
  return {
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    mine: row.sender_id === meId,
    sender_id: row.sender_id,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type ThreadSummary = {
  id: number;
  other: OtherPerson;
  last_message: { body: string; created_at: string; mine: boolean } | null;
  unread: number;
  updated_at: string;
};

/** Every thread the account is in, newest activity first. */
export function listThreads(meId: number): ThreadSummary[] {
  const rows = db
    .prepare(
      `SELECT c.id AS id,
              c.last_message_at AS last_message_at,
              c.created_at AS created_at,
              (SELECT body FROM direct_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS body,
              (SELECT created_at FROM direct_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS body_at,
              (SELECT sender_id FROM direct_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS body_from,
              (SELECT COUNT(*) FROM direct_messages m
                WHERE m.conversation_id = c.id
                  AND m.id > cm.last_read_message_id
                  AND m.sender_id != cm.user_id) AS unread
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = ?
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    )
    .all(meId) as Array<{
    id: number;
    last_message_at: string | null;
    created_at: string;
    body: string | null;
    body_at: string | null;
    body_from: number | null;
    unread: number;
  }>;

  const out: ThreadSummary[] = [];
  for (const row of rows) {
    const other = otherMember(row.id, meId);
    // A one-member thread should not exist; skip rather than render a blank row.
    if (!other) continue;
    out.push({
      id: row.id,
      other,
      last_message:
        row.body === null || row.body_at === null
          ? null
          : { body: row.body, created_at: row.body_at, mine: row.body_from === meId },
      unread: Number(row.unread ?? 0),
      updated_at: row.last_message_at || row.created_at,
    });
  }
  return out;
}

/** Total unread across every thread — what the nav badge shows. */
export function unreadTotal(meId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM direct_messages m
         JOIN conversation_members cm
           ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE m.id > cm.last_read_message_id AND m.sender_id != ?`,
    )
    .get(meId, meId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Find the existing thread with someone, or start one. Idempotent by design. */
export function openThread(meId: number, otherId: number): number {
  if (otherId === meId) throw bad("you cannot message yourself");
  const other = getUser(otherId);
  if (!other) throw notFound("that account does not exist");
  if (other.status !== "active") throw bad("that account is not available");

  const existing = db
    .prepare(
      `SELECT a.conversation_id AS id
         FROM conversation_members a
         JOIN conversation_members b ON b.conversation_id = a.conversation_id
        WHERE a.user_id = ? AND b.user_id = ?`,
    )
    .get(meId, otherId) as { id: number } | undefined;
  if (existing) return existing.id;

  const created = db.prepare("INSERT INTO conversations DEFAULT VALUES").run();
  const id = Number(created.lastInsertRowid);
  const add = db.prepare(
    "INSERT INTO conversation_members (conversation_id, user_id, last_read_message_id) VALUES (?, ?, 0)",
  );
  add.run(id, meId);
  add.run(id, otherId);
  return id;
}

export function listMessages(
  meId: number,
  conversationId: number,
  afterId = 0,
): { messages: ReturnType<typeof publicMessage>[]; other: OtherPerson } {
  assertMember(conversationId, meId);
  const other = otherMember(conversationId, meId);
  if (!other) throw notFound("conversation not found");

  // `after` lets the client poll for just what is new without re-rendering the
  // whole thread; the plain read returns the tail of the history.
  const rows = afterId
    ? (db
        .prepare(
          "SELECT * FROM direct_messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?",
        )
        .all(conversationId, afterId, PAGE_SIZE) as MessageRow[])
    : (db
        .prepare(
          `SELECT * FROM (
             SELECT * FROM direct_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
           ) ORDER BY id`,
        )
        .all(conversationId, PAGE_SIZE) as MessageRow[]);

  return { messages: rows.map((r) => publicMessage(r, meId)), other };
}

export function sendMessage(meId: number, conversationId: number, body: string): MessageRow {
  assertMember(conversationId, meId);
  const created = db
    .prepare("INSERT INTO direct_messages (conversation_id, sender_id, body) VALUES (?, ?, ?)")
    .run(conversationId, meId, body);
  const id = Number(created.lastInsertRowid);
  db.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").run(
    conversationId,
  );
  // Your own message is read by definition — otherwise the badge you just caused
  // would count against you.
  db.prepare(
    "UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?",
  ).run(id, conversationId, meId);
  return db.prepare("SELECT * FROM direct_messages WHERE id = ?").get(id) as MessageRow;
}

export function markRead(meId: number, conversationId: number): void {
  assertMember(conversationId, meId);
  db.prepare(
    `UPDATE conversation_members
        SET last_read_message_id = COALESCE(
              (SELECT MAX(id) FROM direct_messages WHERE conversation_id = ?), 0)
      WHERE conversation_id = ? AND user_id = ?`,
  ).run(conversationId, conversationId, meId);
}

/** Everyone you can start a thread with — used by the empty state's picker. */
export function messageablePeople(meId: number, limit = 50): OtherPerson[] {
  const rows = db
    .prepare(
      `SELECT u.id FROM users u
        WHERE u.id != ? AND u.status = 'active'
        ORDER BY u.id
        LIMIT ?`,
    )
    .all(meId, limit) as Array<{ id: number }>;
  return rows.map((r) => person(r.id)).filter((p): p is OtherPerson => p !== null);
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

/** GET /conversations — the inbox. */
export const listThreadsRoute = h(async (req, res) => {
  const me = req.user as User;
  const threads = listThreads(me.id);
  res.json({
    threads,
    unread: threads.reduce((n, t) => n + t.unread, 0),
    people: threads.length ? undefined : messageablePeople(me.id).slice(0, 12),
  });
});

/** POST /conversations — open (or reuse) a thread with someone. */
export const openThreadRoute = h(async (req, res) => {
  const me = req.user as User;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const otherId = Number(body.user_id);
  if (!Number.isInteger(otherId) || otherId <= 0) throw bad("user_id is required");
  const id = openThread(me.id, otherId);
  res.status(201).json({ id, other: otherMember(id, me.id) });
});

/** GET /conversations/:id/messages?after=<id> — history, or just what is new. */
export const listMessagesRoute = h(async (req, res) => {
  const me = req.user as User;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound("conversation not found");
  const afterRaw = Number(req.query.after ?? 0);
  const after = Number.isFinite(afterRaw) && afterRaw > 0 ? Math.floor(afterRaw) : 0;
  const { messages, other } = listMessages(me.id, id, after);
  // Reading the thread in the app is what "read" means; the client asks for the
  // history, so this is the moment to clear the badge.
  if (!after) markRead(me.id, id);
  res.json({ conversation_id: id, other, messages, unread: unreadTotal(me.id) });
});

/** POST /conversations/:id/messages — send one. */
export const sendMessageRoute = h(async (req, res) => {
  const me = req.user as User;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound("conversation not found");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = requireString(body, "body", MAX_MESSAGE_LEN);
  const row = sendMessage(me.id, id, text);
  res.status(201).json({ message: publicMessage(row, me.id), unread: unreadTotal(me.id) });
});

/**
 * POST /conversations/:id/read — clear the badge without refetching the history.
 *
 * The open thread polls with `after=` (only what is new), which is exactly the
 * request that must NOT mark things read — so the client says so explicitly once
 * the new messages have actually been painted on screen.
 */
export const markReadRoute = h(async (req, res) => {
  const me = req.user as User;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound("conversation not found");
  markRead(me.id, id);
  res.json({ ok: true, unread: unreadTotal(me.id) });
});

/** GET /me/unread — cheap poll for the nav badge. */
export const unreadRoute = h(async (req, res) => {
  const me = req.user as User;
  res.json({ unread: unreadTotal(me.id) });
});
