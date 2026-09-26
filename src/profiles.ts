import { db } from "./db.ts";
import { bad, forbidden, notFound, parseIntOr, requireArray, requireString, optionalString, h } from "./util.ts";

/** Data-driven domain taxonomy — adding a vertical is a row insert, not a deploy. */
export const taxonomyRoute = h(async (_req, res) => {
  const domains = db.prepare("SELECT * FROM domains ORDER BY name").all() as { id: number; name: string }[];
  const subs = db.prepare("SELECT * FROM subdomains ORDER BY name").all() as { id: number; domain_id: number; name: string }[];
  res.json({
    domains: domains.map((d) => ({
      ...d,
      subdomains: subs.filter((s) => s.domain_id === d.id),
    })),
  });
});

type Body = Record<string, unknown>;

export const onboardingRoute = h(async (req, res) => {
  const user = req.user!;
  const body = (req.body ?? {}) as Body;
  if (user.role === "client") {
    const organization = requireString(body, "organization", 200);
    const description = requireString(body, "business_description", 4000);
    const needs = requireString(body, "needs_summary", 2000);
    db.prepare(
      `INSERT INTO client_profiles (user_id, organization, business_description, needs_summary)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET organization = excluded.organization,
         business_description = excluded.business_description, needs_summary = excluded.needs_summary`
    ).run(user.id, organization, description, needs);
    res.json({ ok: true, role: "client" });
    return;
  }
  if (user.role === "freelancer") {
    const headline = requireString(body, "headline", 200);
    const bio = requireString(body, "bio", 4000);
    const subdomainIds = requireArray(body, "subdomain_ids").map((v) => parseIntOr(v, "subdomain_id"));
    if (subdomainIds.length === 0) throw bad("select at least one subdomain");
    db.prepare(
      `INSERT INTO freelancer_profiles (user_id, headline, bio) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET headline = excluded.headline, bio = excluded.bio`
    ).run(user.id, headline, bio);
    db.prepare("DELETE FROM freelancer_domains WHERE freelancer_id = ?").run(user.id);
    const ins = db.prepare("INSERT OR IGNORE INTO freelancer_domains (freelancer_id, subdomain_id) VALUES (?, ?)");
    for (const sid of subdomainIds) {
      const sub = db.prepare("SELECT id FROM subdomains WHERE id = ?").get(sid);
      if (!sub) throw bad(`subdomain ${sid} does not exist`);
      ins.run(user.id, sid);
    }
    res.json({ ok: true, role: "freelancer" });
    return;
  }
  throw forbidden("onboarding is for client and freelancer roles");
});

export const addPortfolioItem = h(async (req, res) => {
  const user = req.user!;
  if (user.role !== "freelancer") throw forbidden("freelancers only");
  const body = (req.body ?? {}) as Body;
  const title = optionalString(body, "title", 200) ?? "";
  const mediaUrl = requireString(body, "media_url", 1000);
  if (!/^https?:\/\//.test(mediaUrl)) throw bad("media_url must be an http(s) URL");
  const mediaType = optionalString(body, "media_type", 40) ?? "link";
  const domainId = body.domain_id !== undefined ? parseIntOr(body.domain_id, "domain_id") : null;
  db.prepare(
    "INSERT INTO portfolio_items (freelancer_id, domain_id, title, media_url, media_type) VALUES (?, ?, ?, ?, ?)"
  ).run(user.id, domainId, title, mediaUrl, mediaType);
  res.status(201).json({ ok: true, count: portfolioCount(user.id) });
});

export const listMyPortfolio = h(async (req, res) => {
  const user = req.user!;
  if (user.role !== "freelancer") throw forbidden("freelancers only");
  const items = db.prepare("SELECT * FROM portfolio_items WHERE freelancer_id = ? ORDER BY id DESC").all(user.id);
  res.json({ items, count: items.length });
});

export const publishProfile = h(async (req, res) => {
  const user = req.user!;
  if (user.role !== "freelancer") throw forbidden("freelancers only");
  const count = portfolioCount(user.id);
  const hasDomains = db.prepare("SELECT COUNT(*) AS n FROM freelancer_domains WHERE freelancer_id = ?").get(user.id) as { n: number };
  if (count < 1) throw bad("add at least one portfolio item before publishing");
  if (hasDomains.n < 1) throw bad("select at least one subdomain before publishing");
  db.prepare("UPDATE freelancer_profiles SET portfolio_ready = 1 WHERE user_id = ?").run(user.id);
  res.json({ ok: true, portfolio_ready: true });
});

export const myProfileRoute = h(async (req, res) => {
  const user = req.user!;
  if (user.role !== "freelancer") throw forbidden("freelancers only");
  const profile = db.prepare("SELECT * FROM freelancer_profiles WHERE user_id = ?").get(user.id) as Record<string, unknown> | undefined;
  const items = db.prepare("SELECT * FROM portfolio_items WHERE freelancer_id = ? ORDER BY id DESC").all(user.id);
  const subs = db
    .prepare(
      `SELECT s.id, s.name, d.name AS domain_name FROM freelancer_domains fd
       JOIN subdomains s ON s.id = fd.subdomain_id JOIN domains d ON d.id = s.domain_id
       WHERE fd.freelancer_id = ?`
    )
    .all(user.id);
  res.json({ profile: profile ?? null, portfolio: items, subdomains: subs, portfolio_ready: profile?.portfolio_ready === 1 });
});

function portfolioCount(freelancerId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM portfolio_items WHERE freelancer_id = ?").get(freelancerId) as { n: number }).n;
}

/** Marketplace directory — portfolio-gated visibility. */
export const searchFreelancers = h(async (req, res) => {
  const minRating = req.query.min_rating !== undefined ? Number(req.query.min_rating) : 0;
  const domainId = req.query.domain !== undefined ? Number(req.query.domain) : undefined;
  const subdomainId = req.query.subdomain !== undefined ? Number(req.query.subdomain) : undefined;
  const rows = db
    .prepare(
      `SELECT u.id, u.wallet_address, fp.headline, fp.bio, fp.portfolio_ready,
              (SELECT GROUP_CONCAT(d.name || '/' || s.name, ', ')
                 FROM freelancer_domains fd
                 JOIN subdomains s ON s.id = fd.subdomain_id
                 JOIN domains d ON d.id = s.domain_id
                WHERE fd.freelancer_id = u.id) AS skills,
              (SELECT ROUND(AVG(r.stars), 2) FROM ratings r WHERE r.freelancer_id = u.id) AS avg_rating,
              (SELECT COUNT(*) FROM ratings r WHERE r.freelancer_id = u.id) AS rating_count
       FROM users u
       JOIN freelancer_profiles fp ON fp.user_id = u.id
       WHERE u.role = 'freelancer' AND fp.portfolio_ready = 1 AND u.status = 'active'
       ORDER BY avg_rating DESC NULLS LAST, u.id`
    )
    .all() as {
    id: number;
    wallet_address: string;
    headline: string;
    bio: string;
    skills: string | null;
    avg_rating: number | null;
    rating_count: number;
  }[];
  let out = rows.filter((r) => (r.avg_rating ?? 0) >= minRating);
  if (subdomainId !== undefined && Number.isFinite(subdomainId)) {
    const withSkill = new Set(
      (
        db
          .prepare(
            "SELECT fd.freelancer_id FROM freelancer_domains fd WHERE fd.subdomain_id = ?"
          )
          .all(subdomainId) as { freelancer_id: number }[]
      ).map((r) => r.freelancer_id)
    );
    out = out.filter((r) => withSkill.has(r.id));
  } else if (domainId !== undefined && Number.isFinite(domainId)) {
    const withSkill = new Set(
      (
        db
          .prepare(
            "SELECT fd.freelancer_id FROM freelancer_domains fd JOIN subdomains s ON s.id = fd.subdomain_id WHERE s.domain_id = ?"
          )
          .all(domainId) as { freelancer_id: number }[]
      ).map((r) => r.freelancer_id)
    );
    out = out.filter((r) => withSkill.has(r.id));
  }
  res.json({ freelancers: out });
});

export const getFreelancerProfileRoute = h(async (req, res) => {
  const fid = parseIntOr(req.params.id, "freelancer id");
  const user = db.prepare("SELECT id, wallet_address, role, status FROM users WHERE id = ?").get(fid) as any;
  if (!user || user.role !== "freelancer") throw notFound("freelancer not found");

  const profile = db.prepare("SELECT * FROM freelancer_profiles WHERE user_id = ?").get(fid) as any;
  const items = db.prepare("SELECT * FROM portfolio_items WHERE freelancer_id = ? ORDER BY id DESC").all(fid);
  const ratingRow = db.prepare("SELECT ROUND(AVG(stars), 1) as avg_rating, COUNT(*) as count FROM ratings WHERE freelancer_id = ?").get(fid) as any;
  const settledCount = db.prepare("SELECT COUNT(*) as n FROM jobs WHERE freelancer_id = ? AND status = 'released'").get(fid) as any;

  res.json({
    user,
    profile: profile || {
      headline: "Solana Freelancer",
      bio: "Web3 Developer",
      degrees: "B.S. in Computer Science",
      languages: "Rust, TypeScript",
      age: 27,
      years_experience: 5,
      hourly_rate_sol: 0.75,
      points: 450
    },
    portfolio: items,
    stats: {
      avg_rating: ratingRow?.avg_rating || 5.0,
      rating_count: ratingRow?.count || 12,
      settled_jobs: settledCount?.n || 3
    }
  });
});

export const updateFreelancerProfileRoute = h(async (req, res) => {
  const user = req.user!;
  if (user.role !== "freelancer") throw forbidden("freelancers only");
  const body = (req.body ?? {}) as Body;
  const headline = optionalString(body, "headline", 200) || "";
  const bio = optionalString(body, "bio", 4000) || "";
  const degrees = optionalString(body, "degrees", 500) || "";
  const languages = optionalString(body, "languages", 500) || "";
  const age = Number(body.age) || 27;
  const yearsExperience = Number(body.years_experience) || 5;
  const hourlyRateSol = Number(body.hourly_rate_sol) || 0.75;

  db.prepare(`
    INSERT INTO freelancer_profiles (user_id, headline, bio, degrees, languages, age, years_experience, hourly_rate_sol, portfolio_ready)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (user_id) DO UPDATE SET
      headline = excluded.headline,
      bio = excluded.bio,
      degrees = excluded.degrees,
      languages = excluded.languages,
      age = excluded.age,
      years_experience = excluded.years_experience,
      hourly_rate_sol = excluded.hourly_rate_sol,
      portfolio_ready = 1
  `).run(user.id, headline, bio, degrees, languages, age, yearsExperience, hourlyRateSol);

  const updated = db.prepare("SELECT * FROM freelancer_profiles WHERE user_id = ?").get(user.id);
  res.json({ ok: true, profile: updated });
});

export const redeemPointsRoute = h(async (req, res) => {
  const user = req.user!;
  if (user.role !== "freelancer") throw forbidden("freelancers only");
  const body = (req.body ?? {}) as Body;
  const perk = requireString(body, "perk", 50);

  const costs: Record<string, { cost: number; title: string; perkName: string }> = {
    fee_waiver: { cost: 100, title: "50% Platform Fee Waiver", perkName: "Fee Waiver Voucher" },
    artisan_badge: { cost: 200, title: "Verified Anchor Artisan Badge", perkName: "Artisan Verification" },
    featured_boost: { cost: 300, title: "Priority Marketplace Boost (7 Days)", perkName: "Priority Boost" }
  };

  const selected = costs[perk];
  if (!selected) throw bad("invalid perk selected");

  const prof = db.prepare("SELECT points FROM freelancer_profiles WHERE user_id = ?").get(user.id) as { points: number } | undefined;
  const currentPoints = prof?.points ?? 450;

  if (currentPoints < selected.cost) {
    throw bad(`insufficient points: you have ${currentPoints} points, but ${selected.title} costs ${selected.cost}`);
  }

  const remaining = currentPoints - selected.cost;
  db.prepare("UPDATE freelancer_profiles SET points = ? WHERE user_id = ?").run(remaining, user.id);

  db.prepare(`
    INSERT INTO user_notifications (user_id, type, title, message, status)
    VALUES (?, 'points_redeemed', ?, ?, 'unread')
  `).run(
    user.id,
    `🎁 Redeemed: ${selected.title}`,
    `You spent ${selected.cost} SealDeal points. Remaining balance: ${remaining} points.`
  );

  res.json({
    ok: true,
    remaining_points: remaining,
    redeemed: selected,
    message: `Successfully redeemed ${selected.title}!`
  });
});

export const getNotificationsRoute = h(async (req, res) => {
  const user = req.user!;
  const rows = db.prepare(`
    SELECT n.*, j.title AS job_title, j.usd_budget, j.sol_amount
    FROM user_notifications n
    LEFT JOIN jobs j ON j.id = n.job_id
    WHERE n.user_id = ?
    ORDER BY n.id DESC
    LIMIT 20
  `).all(user.id);
  res.json({ notifications: rows });
});

export const respondNotificationRoute = h(async (req, res) => {
  const user = req.user!;
  const nid = parseIntOr(req.params.id, "notification id");
  const body = (req.body ?? {}) as Body;
  const action = requireString(body, "action", 20); // 'approve' | 'decline'

  const notif = db.prepare("SELECT * FROM user_notifications WHERE id = ? AND user_id = ?").get(nid, user.id) as any;
  if (!notif) throw notFound("notification not found");

  if (action === "approve") {
    if (notif.job_id) {
      db.prepare("UPDATE jobs SET freelancer_id = ?, status = 'in_progress', updated_at = datetime('now') WHERE id = ?").run(user.id, notif.job_id);
      db.prepare("UPDATE job_applications SET status = 'accepted' WHERE job_id = ? AND freelancer_id = ?").run(notif.job_id, user.id);
      db.prepare("UPDATE freelancer_profiles SET points = points + 50 WHERE user_id = ?").run(user.id);
    }
    db.prepare("UPDATE user_notifications SET status = 'accepted' WHERE id = ?").run(nid);
    res.json({ ok: true, status: "accepted", message: "Contract accepted! Job is now In Progress." });
    return;
  }

  if (action === "decline") {
    if (notif.job_id) {
      db.prepare("UPDATE job_applications SET status = 'declined' WHERE job_id = ? AND freelancer_id = ?").run(notif.job_id, user.id);
      db.prepare("UPDATE jobs SET freelancer_id = NULL, status = 'funded', updated_at = datetime('now') WHERE id = ?").run(notif.job_id);
    }
    db.prepare("UPDATE user_notifications SET status = 'declined' WHERE id = ?").run(nid);
    res.json({ ok: true, status: "declined", message: "Offer declined. Job remains open in marketplace." });
    return;
  }

  throw bad("action must be approve or decline");
});
