import { db } from "./db.ts";
import { h } from "./util.ts";

/**
 * Composite freelancer score (weights are a documented placeholder per workflow.md §6 —
 * reference spec pending):
 *   completion 0.4 + rating 0.3 + on-time 0.15 + dispute-loss 0.15 (scaled to 0..100)
 * Recomputed on demand and by the hourly scheduler in server.ts.
 */
export const WEIGHTS = { completion: 0.4, rating: 0.3, onTime: 0.15, disputeLoss: 0.15 } as const;

export function recomputeLeaderboard(): void {
  const freelancers = db.prepare("SELECT id FROM users WHERE role = 'freelancer'").all() as { id: number }[];
  const put = db.prepare(
    `INSERT INTO leaderboard_scores (freelancer_id, score, breakdown_json) VALUES (?, ?, ?)
     ON CONFLICT(freelancer_id) DO UPDATE SET score = excluded.score,
       breakdown_json = excluded.breakdown_json, computed_at = datetime('now')`
  );
  for (const f of freelancers) {
    const stats = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status IN ('closed_no_payout','held_detached') THEN 1 ELSE 0 END) AS lost
         FROM jobs WHERE freelancer_id = ?`
      )
      .get(f.id) as { total: number; completed: number | null; lost: number | null };
    const rating = db
      .prepare("SELECT AVG(stars) AS avg FROM ratings WHERE freelancer_id = ?")
      .get(f.id) as { avg: number | null };
    const disputes = db
      .prepare(
        `SELECT COUNT(*) AS n FROM disputes d JOIN jobs j ON j.id = d.job_id
         WHERE j.freelancer_id = ? AND d.status = 'ruled' AND d.ruling LIKE '%hold_buyer%'`
      )
      .get(f.id) as { n: number };
    const total = stats.total ?? 0;
    const completed = stats.completed ?? 0;
    const completionRate = total > 0 ? completed / total : 0;
    const ratingNorm = (rating.avg ?? 0) / 5;
    const onTimeRate = completed > 0 ? 1 : 0; // deliveries before deadline — deadline tracking is v2
    const disputeLossRate = completed + (stats.lost ?? 0) > 0 ? disputes.n / (completed + (stats.lost ?? 0)) : 0;
    const score =
      100 * (WEIGHTS.completion * completionRate + WEIGHTS.rating * ratingNorm + WEIGHTS.onTime * onTimeRate - WEIGHTS.disputeLoss * disputeLossRate);
    put.run(f.id, Math.max(0, Math.round(score * 100) / 100), JSON.stringify({
      total_jobs: total,
      completed_jobs: completed,
      completion_rate: Math.round(completionRate * 1000) / 1000,
      avg_rating: rating.avg,
      dispute_losses: disputes.n,
      weights: WEIGHTS,
    }));
  }
}

export const leaderboardRoute = h(async (_req, res) => {
  const rows = db
    .prepare(
      `SELECT l.score, l.breakdown_json, l.computed_at, u.id AS freelancer_id, u.wallet_address,
              fp.headline
       FROM leaderboard_scores l
       JOIN users u ON u.id = l.freelancer_id
       LEFT JOIN freelancer_profiles fp ON fp.user_id = u.id
       WHERE u.status = 'active'
       ORDER BY l.score DESC LIMIT 100`
    )
    .all();
  res.json({
    leaderboard: rows.map((r: Record<string, unknown>) => ({
      ...r,
      breakdown: JSON.parse(String(r.breakdown_json ?? "{}")),
    })),
  });
});
