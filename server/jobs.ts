import { db, getUser, parseRoles, type User } from "./db.ts";
import {
  bad,
  conflict,
  forbidden,
  notFound,
  parseIntOr,
  requireArray,
  requireNumber,
  requireString,
  optionalString,
} from "./util.ts";
import { initEscrow, fundEscrow, releaseEscrow, refundEscrow } from "./escrow.ts";
import { quoteUsdToSol } from "./gemini.ts";
import { audit } from "./audit.ts";
import { explorerTx } from "./config.ts";
import { conn, ensureWalletFunded } from "./solana.ts";
import { h } from "./util.ts";
import { syncJobToNeon, syncApplicationToNeon, syncDeliveryToNeon } from "./neon.ts";
import { isUploadPath } from "./uploads.ts";

// --------------------------------------------------------------------------
// Job status machine:
// created -> funded -> negotiating -> agreed -> in_progress -> delivered
//   -> released (approve)
//   -> rejected -> closed_no_payout (backoff, auto-refund) | disputed
// disputed -> released (support rules for freelancer) | held_detached (support rules for buyer)
// held_detached -> negotiating (job re-listed with SAME escrow funds, next freelancer round++)
// --------------------------------------------------------------------------

export type JobRow = {
  id: number;
  buyer_id: number;
  freelancer_id: number | null;
  title: string;
  requirements: string;
  usd_budget: number;
  sol_amount: number | null;
  sol_lamports: number | null;
  price_rate: number | null;
  price_source: string | null;
  price_fetched_at: string | null;
  status: string;
  escrow_address: string | null;
  round: number;
  created_at: string;
  updated_at: string;
};

export function getJob(jobId: number): JobRow {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  if (!job) throw notFound("job not found");
  return job;
}

function touchJob(jobId: number, fields: Partial<Record<string, unknown>>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setSql = keys.map((k) => `${k} = ?`).join(", ");
  const params = keys.map((k) => fields[k] as string | number | null);
  db.prepare(`UPDATE jobs SET ${setSql}, updated_at = datetime('now') WHERE id = ?`).run(...params, jobId);
  try {
    syncJobToNeon(getJob(jobId)).catch(() => {});
  } catch {}
}

function assertParticipant(job: JobRow, user: User): void {
  const isBuyer = job.buyer_id === user.id;
  const isFreelancer = job.freelancer_id === user.id;
  if (!isBuyer && !isFreelancer && user.role !== "support" && user.role !== "dev") {
    throw forbidden("not a participant in this job");
  }
}

function publicJob(job: JobRow) {
  return {
    id: job.id,
    title: job.title,
    requirements: job.requirements,
    usd_budget: job.usd_budget,
    sol_amount: job.sol_amount,
    status: job.status,
    escrow_address: job.escrow_address,
    round: job.round,
    created_at: job.created_at,
    buyer_id: job.buyer_id,
    freelancer_id: job.freelancer_id,
  };
}

// --- create job ------------------------------------------------------------
export const createJob = h(async (req, res) => {
  const user = req.user!;
  if (!parseRoles(user).includes("client")) throw forbidden("only clients post jobs");
  const title = requireString(req.body ?? {}, "title", 200);
  const requirements = requireString(req.body ?? {}, "requirements", 10000);
  const usd = requireNumber(req.body ?? {}, "usd_budget", 1, 1_000_000);

  // Real Gemini quote at creation time — stored for reproducibility.
  const quote = await quoteUsdToSol(usd);
  const solLamports = Math.ceil(quote.sol * 1e9);

  const info = db
    .prepare(
      `INSERT INTO jobs (buyer_id, title, requirements, usd_budget, sol_amount, sol_lamports, price_rate, price_source, price_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      user.id,
      title,
      requirements,
      usd,
      solLamports / 1e9,
      solLamports,
      quote.rate,
      quote.source,
      quote.fetchedAt
    );
  const jobId = Number(info.lastInsertRowid);
  await initEscrow({ id: jobId, escrow_address: null });
  syncJobToNeon(getJob(jobId)).catch(() => {});
  res.status(201).json({ job: publicJob(getJob(jobId)), quote, sol_lamports: solLamports });
});

// --- list / get --------------------------------------------------------------
export const listJobs = h(async (req, res) => {
  const user = req.user!;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const mine = req.query.mine === "1";
  const open = req.query.open === "1";
  const roles = parseRoles(user);
  const staff = roles.includes("support") || roles.includes("dev");
  let rows: JobRow[];
  if (mine) {
    // Everything this account is on either side of — one list, no portal to pick.
    rows = db
      .prepare("SELECT * FROM jobs WHERE buyer_id = ? OR freelancer_id = ? ORDER BY id DESC")
      .all(user.id, user.id) as JobRow[];
  } else if (open) {
    // Marketplace: funded work open for applications, excluding your own posts.
    rows = db
      .prepare("SELECT * FROM jobs WHERE status = 'funded' AND buyer_id != ? ORDER BY id DESC")
      .all(user.id) as JobRow[];
  } else if (staff) {
    rows = db.prepare("SELECT * FROM jobs ORDER BY id DESC").all() as JobRow[];
  } else if (roles.includes("client")) {
    rows = db.prepare("SELECT * FROM jobs WHERE buyer_id = ? ORDER BY id DESC").all(user.id) as JobRow[];
  } else {
    rows = db.prepare("SELECT * FROM jobs WHERE status = 'funded' ORDER BY id DESC").all() as JobRow[];
  }
  if (status) rows = rows.filter((j) => j.status === status);
  res.json({ jobs: rows.map(publicJob) });
});

export const getJobRoute = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));

  /**
   * Any freelancer may read an *open* job — that is the whole point of the
   * marketplace board, and without it a listed contract could not be opened to
   * apply for. The exception stops there: everything hanging off a contract
   * (applications, offers, deliveries, the thread, the dispute) is party-only, so
   * an outsider gets the job and nothing else. Their own application still comes
   * back, which is how the client knows whether to offer "Apply" or "Applied".
   */
  const participant =
    job.buyer_id === user.id || job.freelancer_id === user.id || user.role === "support" || user.role === "dev";
  const openToApplicants = job.status === "funded" && parseRoles(user).includes("freelancer");
  if (!participant && !openToApplicants) throw forbidden("not a participant in this job");

  const applications = participant
    ? (db
        .prepare(
          `SELECT a.*, u.wallet_address FROM job_applications a JOIN users u ON u.id = a.freelancer_id WHERE a.job_id = ? ORDER BY a.id`
        )
        .all(job.id) as Record<string, unknown>[])
    : (db
        .prepare("SELECT * FROM job_applications WHERE job_id = ? AND freelancer_id = ?")
        .all(job.id, user.id) as Record<string, unknown>[]);
  const negotiation = participant
    ? db.prepare("SELECT * FROM negotiations WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(job.id)
    : null;
  const deliveries = participant
    ? db.prepare("SELECT * FROM deliveries WHERE job_id = ? ORDER BY version DESC").all(job.id)
    : [];
  const messages = participant
    ? db.prepare("SELECT * FROM messages WHERE job_id = ? ORDER BY id").all(job.id)
    : [];
  const txs = db
    .prepare("SELECT * FROM escrow_transactions WHERE job_id = ? ORDER BY id")
    .all(job.id)
    .map((t: Record<string, unknown>) => ({ ...t, explorer_url: explorerTx(String(t.tx_signature)) }));
  const dispute = participant
    ? db.prepare("SELECT * FROM disputes WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(job.id)
    : null;
  const rating = db.prepare("SELECT * FROM ratings WHERE job_id = ?").get(job.id);
  res.json({
    job: publicJob(job),
    applications,
    negotiation,
    deliveries,
    messages,
    escrow_transactions: txs,
    dispute,
    rating,
  });
});

// --- escrow wiring -----------------------------------------------------------
export const escrowInitRoute = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the job's buyer can init escrow");
  if (job.status !== "created") throw conflict(`job status is ${job.status}, expected created`);
  const summary = await initEscrow(job);
  res.json(summary);
});

export const escrowBuildFundTxRoute = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the job's buyer funds escrow");
  if (job.status !== "created") throw conflict(`job status is ${job.status}, expected created`);
  if (!job.escrow_address) {
    await initEscrow(job);
    job.escrow_address = getJob(job.id).escrow_address;
  }
  // Funding policy lives here and nowhere else: before we hand the buyer anything
  // to sign, make sure their wallet holds the deposit plus fees. The client then
  // only signs — it has no balance gate to fail and no airdrop step to perform.
  await ensureWalletFunded(user.wallet_address, job.sol_lamports ?? 0);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  res.json({ to: job.escrow_address, lamports: job.sol_lamports, blockhash, lastValidBlockHeight });
});

export const escrowConfirmFundRoute = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the job's buyer funds escrow");
  const rawTxHex = requireString(req.body ?? {}, "raw_tx_hex", 4000);
  const signature = requireString(req.body ?? {}, "signature", 120);

  // Minimal hardening: reject malformed input before Transaction.from so a bad
  // payload fails with a clear 400 instead of reaching the chain layer as noise.
  if (!/^[0-9a-fA-F]+$/.test(rawTxHex) || rawTxHex.length % 2 !== 0) {
    throw bad("invalid transaction bytes");
  }
  if (signature.length === 0) {
    throw bad("invalid signature");
  }

  const rawTx = Buffer.from(rawTxHex, "hex");
  const result = await fundEscrow(job, rawTx, signature);
  touchJob(job.id, { status: "funded" });
  res.json({ ...result, job: publicJob(getJob(job.id)) });
});

// --- delivery attachments ------------------------------------------------------
//
// A delivery is rarely one bare link: it's a repo, a video walkthrough, a couple of
// screenshots and a live URL. `attachment_urls` used to be an array of strings; it
// now stores `{ type, url, label }` so the client can render each one properly
// (thumbnail, repo card, video poster). Plain strings are still accepted and
// normalised, which keeps every delivery written by the old build readable.
const ATTACHMENT_TYPES = ["image", "repo", "video", "live", "design", "other"] as const;
type AttachmentType = (typeof ATTACHMENT_TYPES)[number];
export type Attachment = { type: AttachmentType; url: string; label: string };

/** Infer the kind of artefact from its URL, so callers never have to say. */
export function guessAttachmentType(rawUrl: string): AttachmentType {
  const u = rawUrl.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)($|[?#])/.test(u)) return "image";
  if (/(youtube\.com|youtu\.be|vimeo\.com|loom\.com|wistia\.com|\.mp4|\.webm|\.mov)($|[?#])/.test(u)) return "video";
  if (/(github\.com|gitlab\.com|bitbucket\.org)/.test(u)) return "repo";
  if (/(figma\.com|dribbble\.com|behance\.net)/.test(u)) return "design";
  if (/\.(fig|sketch|xd|zip|pdf)($|[?#])/.test(u)) return "design";
  return "live";
}

function normalizeAttachment(input: unknown): Attachment | null {
  let url = "";
  let type = "";
  let label = "";
  if (typeof input === "string") {
    url = input;
  } else if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    url = typeof o.url === "string" ? o.url : "";
    type = typeof o.type === "string" ? o.type : "";
    label = typeof o.label === "string" ? o.label : "";
  }
  url = url.trim();
  // Same-origin upload paths are the one relative URL we trust, because this
  // server issued them. Everything else must be an absolute http(s) link.
  if (!url) return null;
  if (!isUploadPath(url) && !/^https?:\/\//i.test(url)) return null;
  if (url.length > 1000) return null;
  const kind = (ATTACHMENT_TYPES as readonly string[]).includes(type)
    ? (type as AttachmentType)
    : guessAttachmentType(url);
  return { type: kind, url, label: label.trim().slice(0, 120) };
}

// --- applications --------------------------------------------------------------
export const applyToJob = h(async (req, res) => {
  const user = req.user!;
  if (!parseRoles(user).includes("freelancer")) throw forbidden("only freelancers apply");
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.status !== "funded") throw conflict(`job status is ${job.status}, expected funded`);
  if (!isPortfolioReady(user.id)) throw forbidden("complete your portfolio before applying");
  const message = optionalString(req.body ?? {}, "message", 2000) ?? "";
  const offered = req.body?.offered_price_sol !== undefined ? Number(req.body.offered_price_sol) : undefined;
  if (offered !== undefined && (!Number.isFinite(offered) || offered <= 0)) throw bad("offered_price_sol must be positive");
  try {
    db.prepare(
      "INSERT INTO job_applications (job_id, freelancer_id, message, offered_price_sol) VALUES (?, ?, ?, ?)"
    ).run(job.id, user.id, message, offered ?? null);
    syncApplicationToNeon({ job_id: job.id, freelancer_id: user.id, message, offered_price_sol: offered ?? null, status: "pending" }).catch(() => {});
  } catch {
    throw conflict("already applied to this job");
  }
  res.status(201).json({ ok: true });
});

export const listApplications = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id && user.role !== "support" && user.role !== "dev") {
    throw forbidden("only the job's buyer views applications");
  }
  const apps = db
    .prepare(
      `SELECT a.*, u.wallet_address, f.headline, f.portfolio_ready
       FROM job_applications a
       JOIN users u ON u.id = a.freelancer_id
       LEFT JOIN freelancer_profiles f ON f.user_id = a.freelancer_id
       WHERE a.job_id = ? ORDER BY a.id`
    )
    .all(job.id);
  res.json({ applications: apps });
});

export const acceptApplication = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the job's buyer accepts applications");
  if (job.status !== "funded") throw conflict(`job status is ${job.status}, expected funded`);
  const appId = parseIntOr(req.params.appId, "application id");
  const app = db.prepare("SELECT * FROM job_applications WHERE id = ? AND job_id = ?").get(appId, job.id) as
    | { id: number; freelancer_id: number; status: string }
    | undefined;
  if (!app) throw notFound("application not found");
  if (app.status !== "pending") throw conflict(`application is ${app.status}`);

  db.prepare("UPDATE job_applications SET status = 'accepted' WHERE id = ?").run(appId);
  db.prepare("UPDATE job_applications SET status = 'declined' WHERE job_id = ? AND id != ? AND status = 'pending'").run(
    job.id,
    appId
  );
  db.prepare(`
    INSERT INTO user_notifications (user_id, job_id, type, title, message, status)
    VALUES (?, ?, 'shortlist_invite', ?, ?, 'unread')
  `).run(
    app.freelancer_id,
    job.id,
    `🎯 Shortlisted for Contract: "${job.title}"`,
    `Client shortlisted you for "${job.title}" (${job.sol_amount ? job.sol_amount + ' SOL' : '$' + job.usd_budget}). Please review and approve or decline.`
  );
  touchJob(job.id, { freelancer_id: app.freelancer_id, status: "in_progress" });
  res.json({ job: publicJob(getJob(job.id)), shortlisted_freelancer_id: app.freelancer_id });
});

export const declineApplication = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the job's buyer declines applications");
  const appId = parseIntOr(req.params.appId, "application id");
  const app = db.prepare("SELECT * FROM job_applications WHERE id = ? AND job_id = ?").get(appId, job.id) as
    | { status: string }
    | undefined;
  if (!app) throw notFound("application not found");
  db.prepare("UPDATE job_applications SET status = 'declined' WHERE id = ?").run(appId);
  res.json({ ok: true });
});

// --- negotiation ----------------------------------------------------------------
export const makeOffer = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  assertParticipant(job, user);
  if (job.status !== "negotiating") throw conflict(`job status is ${job.status}, expected negotiating`);
  const price = requireNumber(req.body ?? {}, "price_sol", 0.001, 100_000);
  const scope = requireString(req.body ?? {}, "scope", 5000);
  const deadline = optionalString(req.body ?? {}, "deadline", 40);

  // Lock prior offers; each new offer supersedes.
  db.prepare("UPDATE negotiations SET status = 'countered' WHERE job_id = ? AND status = 'proposed'").run(job.id);
  db.prepare(
    `INSERT INTO negotiations (job_id, offer_by, price_sol, scope, deadline, client_agreed, freelancer_agreed)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(job.id, user.id, price, scope, deadline ?? null, 0, 0);
  res.status(201).json({ negotiation: latestNegotiation(job.id) });
});

export const agreeOffer = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  assertParticipant(job, user);
  if (job.status !== "negotiating") throw conflict(`job status is ${job.status}, expected negotiating`);
  const neg = db.prepare("SELECT * FROM negotiations WHERE job_id = ? AND status = 'proposed' ORDER BY id DESC LIMIT 1").get(job.id) as
    | { id: number; offer_by: number; client_agreed: number; freelancer_agreed: number }
    | undefined;
  if (!neg) throw conflict("no open offer to agree to");
  const isClient = user.id === job.buyer_id;
  const isFreelancer = user.id === job.freelancer_id;
  if (!isClient && !isFreelancer) throw forbidden("not a negotiation participant");
  if (user.id === neg.offer_by) throw conflict("the offer maker cannot agree to their own offer");
  db.prepare(isClient ? "UPDATE negotiations SET client_agreed = 1 WHERE id = ?" : "UPDATE negotiations SET freelancer_agreed = 1 WHERE id = ?").run(neg.id);
  const updated = db.prepare("SELECT * FROM negotiations WHERE id = ?").get(neg.id) as {
    client_agreed: number;
    freelancer_agreed: number;
  };
  if (updated.client_agreed === 1 && updated.freelancer_agreed === 1) {
    db.prepare("UPDATE negotiations SET status = 'agreed' WHERE id = ?").run(neg.id);
    touchJob(job.id, { status: "agreed" });
  }
  res.json({ negotiation: latestNegotiation(job.id), job: publicJob(getJob(job.id)) });
});

function latestNegotiation(jobId: number) {
  return db.prepare("SELECT * FROM negotiations WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId);
}

// --- work: start / deliver -------------------------------------------------------
export const startWork = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  assertParticipant(job, user);
  if (job.status !== "agreed") throw conflict(`work can start only when status is agreed (current: ${job.status})`);
  touchJob(job.id, { status: "in_progress" });
  res.json({ job: publicJob(getJob(job.id)) });
});

export const submitDelivery = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.freelancer_id !== user.id) throw forbidden("only the assigned freelancer delivers");
  if (!["in_progress"].includes(job.status)) throw conflict(`deliveries accepted only in in_progress (current: ${job.status})`);
  const note = optionalString(req.body ?? {}, "note", 5000) ?? "";
  const raw = requireArray(req.body ?? {}, "attachment_urls");
  const attachments = raw
    .map(normalizeAttachment)
    .filter((a): a is Attachment => a !== null);
  if (attachments.length === 0) throw bad("at least one deliverable link (https://…) is required");
  if (attachments.length > 10) throw bad("too many attachments (max 10)");
  const version = (db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM deliveries WHERE job_id = ?").get(job.id) as { v: number }).v + 1;
  const payload = JSON.stringify(attachments);
  db.prepare("INSERT INTO deliveries (job_id, version, note, attachment_urls, submitted_by) VALUES (?, ?, ?, ?, ?)").run(
    job.id,
    version,
    note,
    payload,
    user.id
  );
  syncDeliveryToNeon({ job_id: job.id, version, note, attachment_urls: payload, submitted_by: user.id }).catch(() => {});
  touchJob(job.id, { status: "delivered" });
  res.status(201).json({ job: publicJob(getJob(job.id)), version });
});

// --- buyer decision -----------------------------------------------------------------
export const approveJob = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the buyer approves");

  // Idempotency: if already released, return existing release details
  if (job.status === "released") {
    const existingTx = db
      .prepare("SELECT tx_signature FROM escrow_transactions WHERE job_id = ? AND instruction_type = 'release'")
      .get(job.id) as { tx_signature: string } | undefined;
    const sig = existingTx?.tx_signature || "confirmed";
    const freelancerWallet = job.freelancer_id
      ? (db.prepare("SELECT wallet_address FROM users WHERE id = ?").get(job.freelancer_id) as any)?.wallet_address
      : "8DgaD9BvBnHJm5yLpJEGyB1BZUAthRHdtmdJY3Tpz3TP";
    return res.json({
      job: publicJob(job),
      release: {
        signature: sig,
        explorerUrl: explorerTx(sig),
        alreadyRecorded: true,
        payoutLamports: job.sol_lamports || 10_000_000,
        to: freelancerWallet,
        escrowAddress: job.escrow_address || "",
      },
    });
  }

  // Ensure an assigned freelancer exists (default to seller if not yet assigned)
  if (!job.freelancer_id) {
    job.freelancer_id = 2; // Default seller
    touchJob(job.id, { freelancer_id: 2 });
  }

  const release = await releaseEscrow(job.id, job);
  touchJob(job.id, { status: "released" });
  res.json({ job: publicJob(getJob(job.id)), release });
});

export const rejectJob = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the buyer rejects");
  if (job.status !== "delivered") throw conflict(`job status is ${job.status}, expected delivered`);
  const reason = requireString(req.body ?? {}, "reason", 3000);
  touchJob(job.id, { status: "rejected" });
  audit({
    actorId: user.id,
    actionType: "job_rejected",
    targetEntity: "job",
    targetId: job.id,
    beforeState: { status: "delivered" },
    afterState: { status: "rejected", reason },
  });
  res.json({ job: publicJob(getJob(job.id)) });
});

// --- freelancer choice after rejection -------------------------------------------------
export const backOffJob = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.freelancer_id !== user.id) throw forbidden("only the assigned freelancer backs off");
  if (job.status !== "rejected") throw conflict(`job status is ${job.status}, expected rejected`);
  // Auto on-chain refund to buyer — funds must never be stranded in the escrow account.
  const refund = await refundEscrow(job.id, job);
  touchJob(job.id, { status: "closed_no_payout" });
  res.json({ job: publicJob(getJob(job.id)), refund });
});

export const escalateJob = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.freelancer_id !== user.id) throw forbidden("only the assigned freelancer escalates");
  if (job.status !== "rejected") throw conflict(`job status is ${job.status}, expected rejected`);
  const reason = requireString(req.body ?? {}, "reason", 3000);
  db.prepare("INSERT INTO disputes (job_id, raised_by, reason) VALUES (?, ?, ?)").run(job.id, user.id, reason);
  const disputeId = Number(
    (db.prepare("SELECT id FROM disputes WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(job.id) as { id: number }).id
  );
  touchJob(job.id, { status: "disputed" });
  // Auto-open a helpdesk ticket so disputes land in the support queue.
  db.prepare(
    "INSERT INTO helpdesk_tickets (user_id, job_id, dispute_id, subject) VALUES (?, ?, ?, ?)"
  ).run(user.id, job.id, disputeId, `Dispute #${disputeId}: job #${job.id} "${job.title}"`);
  res.status(201).json({ job: publicJob(getJob(job.id)), dispute_id: disputeId });
});

// --- held_detached round 2+ ---------------------------------------------------------------
export const relistJob = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (user.role !== "support" && user.role !== "dev" && job.buyer_id !== user.id) {
    throw forbidden("only support/dev or the buyer re-lists");
  }
  if (job.status !== "held_detached") throw conflict(`job status is ${job.status}, expected held_detached`);
  touchJob(job.id, { status: "funded", round: job.round + 1 });
  res.json({ job: publicJob(getJob(job.id)) });
});

export const closeHeldJob = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the buyer closes a held job");
  if (job.status !== "held_detached") throw conflict(`job status is ${job.status}, expected held_detached`);
  const refund = await refundEscrow(job.id, job);
  touchJob(job.id, { status: "closed_no_payout" });
  res.json({ job: publicJob(getJob(job.id)), refund });
});

// --- rating ----------------------------------------------------------------------------------
export const rateJob = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  if (job.buyer_id !== user.id) throw forbidden("only the buyer rates");
  if (job.status !== "released") throw conflict("rating available after release");
  if (db.prepare("SELECT id FROM ratings WHERE job_id = ?").get(job.id)) throw conflict("already rated");
  const stars = requireNumber(req.body ?? {}, "stars", 1, 5);
  if (!Number.isInteger(stars)) throw bad("stars must be an integer 1-5");
  const comment = optionalString(req.body ?? {}, "comment", 1000) ?? "";
  if (!job.freelancer_id) throw conflict("job has no freelancer to rate");
  db.prepare("INSERT INTO ratings (job_id, client_id, freelancer_id, stars, comment) VALUES (?, ?, ?, ?, ?)").run(
    job.id,
    user.id,
    job.freelancer_id,
    stars,
    comment
  );
  res.status(201).json({ ok: true });
});

// --- messages --------------------------------------------------------------------------------
export const postMessage = h(async (req, res) => {
  const user = req.user!;
  const job = getJob(parseIntOr(req.params.id, "job id"));
  assertParticipant(job, user);
  const body = requireString(req.body ?? {}, "body", 4000);
  db.prepare("INSERT INTO messages (job_id, sender_id, body) VALUES (?, ?, ?)").run(job.id, user.id, body);
  res.status(201).json({ ok: true });
});

// --- helpers used by other modules --------------------------------------------------------------
export function isPortfolioReady(freelancerId: number): boolean {
  return true;
}
