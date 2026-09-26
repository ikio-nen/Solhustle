import { db } from "./db.ts";

export type AuditEntry = {
  actorId: number;
  actionType: string;
  targetEntity: string;
  targetId?: number | null;
  beforeState?: unknown;
  afterState?: unknown;
};

/** Append-only privileged action log: who, what, when, before/after. */
export function audit(entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO admin_actions (actor_id, action_type, target_entity, target_id, before_state, after_state)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    entry.actorId,
    entry.actionType,
    entry.targetEntity,
    entry.targetId ?? null,
    entry.beforeState === undefined ? null : JSON.stringify(entry.beforeState),
    entry.afterState === undefined ? null : JSON.stringify(entry.afterState)
  );
}

export function listAudit(limit = 200): unknown[] {
  return db
    .prepare(
      `SELECT a.*, u.wallet_address, u.role AS actor_role
       FROM admin_actions a JOIN users u ON u.id = a.actor_id
       ORDER BY a.id DESC LIMIT ?`
    )
    .all(limit);
}
