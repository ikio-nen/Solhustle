import { db } from "./db.ts";
import { notFound } from "./util.ts";
import type { JobRow } from "./jobs.ts";
import { syncJobToNeon } from "./neon.ts";

export function getJob(jobId: number): JobRow {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  if (!job) throw notFound("job not found");
  return job;
}

export function touchJobSafe(jobId: number, fields: Partial<Record<string, unknown>>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setSql = keys.map((k) => `${k} = ?`).join(", ");
  const params = keys.map((k) => fields[k] as string | number | null);
  db.prepare(`UPDATE jobs SET ${setSql}, updated_at = datetime('now') WHERE id = ?`).run(...params, jobId);
  try {
    syncJobToNeon(getJob(jobId)).catch(() => {});
  } catch {}
}
