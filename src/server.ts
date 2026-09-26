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

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as web3 from "@solana/web3.js";
import { db } from "./db.ts";
import { config } from "./config.ts";
import {
  challengeRoute,
  verifyRoute,
  loginRoute,
  registerRoute,
  meRoute,
  requireAuth,
  requireRole,
  maybeAuth,
  type AuthedRequest,
} from "./auth.ts";
import {
  createJob,
  listJobs,
  getJobRoute,
  escrowInitRoute,
  escrowBuildFundTxRoute,
  escrowConfirmFundRoute,
  applyToJob,
  listApplications,
  acceptApplication,
  declineApplication,
  makeOffer,
  agreeOffer,
  startWork,
  submitDelivery,
  approveJob,
  rejectJob,
  backOffJob,
  escalateJob,
  relistJob,
  closeHeldJob,
  rateJob,
  postMessage,
} from "./jobs.ts";
import {
  taxonomyRoute,
  onboardingRoute,
  addPortfolioItem,
  listMyPortfolio,
  publishProfile,
  myProfileRoute,
  searchFreelancers,
  getFreelancerProfileRoute,
  updateFreelancerProfileRoute,
  redeemPointsRoute,
  getNotificationsRoute,
  respondNotificationRoute
} from "./profiles.ts";
import { listDisputes, getDispute, ruleDispute, disputeEvidence } from "./disputes.ts";
import { createTicket, listTickets, getTicket, replyTicket, resolveTicket } from "./tickets.ts";
import { leaderboardRoute, recomputeLeaderboard } from "./leaderboard.ts";
import { healthRoute, reconciliationRoute, auditRoute, listUsers, setUserStatus, userDetail } from "./admin.ts";
import { getSolUsdRate } from "./gemini.ts";
import { bad, tooMany, parseIntOr, notFound } from "./util.ts";
import { platformKeypair } from "./keys.ts";
import { buildSignedTransfer, conn } from "./solana.ts";
import { explorerAccount } from "./config.ts";
import { ensureDemoActors, seedTaxonomy } from "./seed.ts";
import { requestAirdrop } from "./solana.ts";
import type { User } from "./db.ts";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- simple in-memory rate limiter -------------------------------------------
const buckets = new Map<string, { tokens: number; last: number }>();
app.use((req, res, next) => {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: 30, last: now };
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(30, b.tokens + elapsed * 2); // refill 2/s
  b.last = now;
  if (b.tokens < 1) return next(tooMany());
  b.tokens -= 1;
  buckets.set(key, b);
  next();
});

// --- auth ---------------------------------------------------------------
app.post("/auth/challenge", h_wrap(challengeRoute));
app.post("/auth/verify", h_wrap(verifyRoute));
app.post("/auth/login", h_wrap(loginRoute));
app.post("/auth/register", h_wrap(registerRoute));
app.get("/auth/me", requireAuth, h_wrap(meRoute));

// --- meta -----------------------------------------------------------------
app.get("/meta/taxonomy", taxonomyRoute);
app.get("/meta/network", (_req, res) => {
  res.json({ chain: config.chain, explorer_cluster: config.chain });
});
app.get("/meta/price", h_wrap(async (req, res) => {
  const { rate, fetched_at, live } = await getSolUsdRate();
  res.json({ pair: "SOL/USD", rate, fetched_at, live });
}));

// --- profiles / onboarding ---------------------------------------------------
app.post("/me/onboarding", requireAuth, h_wrap(onboardingRoute));
app.get("/me/profile", requireAuth, h_wrap(myProfileRoute));
app.post("/me/portfolio", requireAuth, h_wrap(addPortfolioItem));
app.get("/me/portfolio", requireAuth, h_wrap(listMyPortfolio));
app.post("/me/portfolio/publish", requireAuth, h_wrap(publishProfile));
app.get("/freelancers", maybeAuth, h_wrap(searchFreelancers));
app.get("/freelancer/profile/:id", h_wrap(getFreelancerProfileRoute));
app.post("/me/freelancer/profile", requireAuth, h_wrap(updateFreelancerProfileRoute));
app.post("/me/points/redeem", requireAuth, h_wrap(redeemPointsRoute));
app.get("/me/notifications", requireAuth, h_wrap(getNotificationsRoute));
app.post("/notifications/:id/respond", requireAuth, h_wrap(respondNotificationRoute));

// --- jobs ------------------------------------------------------------------
app.post("/jobs", requireAuth, h_wrap(createJob));
app.get("/jobs", requireAuth, h_wrap(listJobs));
app.get("/jobs/:id", requireAuth, h_wrap(getJobRoute));
app.post("/jobs/:id/messages", requireAuth, h_wrap(postMessage));
app.post("/jobs/:id/apply", requireAuth, h_wrap(applyToJob));
app.get("/jobs/:id/applications", requireAuth, h_wrap(listApplications));
app.post("/jobs/:id/applications/:appId/accept", requireAuth, h_wrap(acceptApplication));
app.post("/jobs/:id/applications/:appId/decline", requireAuth, h_wrap(declineApplication));
app.post("/jobs/:id/negotiate", requireAuth, h_wrap(makeOffer));
app.post("/jobs/:id/agree", requireAuth, h_wrap(agreeOffer));
app.post("/jobs/:id/start", requireAuth, h_wrap(startWork));
app.post("/jobs/:id/deliveries", requireAuth, h_wrap(submitDelivery));
app.post("/jobs/:id/approve", requireAuth, h_wrap(approveJob));
app.post("/jobs/:id/reject", requireAuth, h_wrap(rejectJob));
app.post("/jobs/:id/backoff", requireAuth, h_wrap(backOffJob));
app.post("/jobs/:id/escalate", requireAuth, h_wrap(escalateJob));
app.post("/jobs/:id/relist", requireAuth, h_wrap(relistJob));
app.post("/jobs/:id/close-held", requireAuth, h_wrap(closeHeldJob));
app.post("/jobs/:id/rating", requireAuth, h_wrap(rateJob));

// --- escrow ------------------------------------------------------------------
app.post("/escrow/:id/init", requireAuth, h_wrap(escrowInitRoute));
app.post("/escrow/:id/fund/build-tx", requireAuth, h_wrap(escrowBuildFundTxRoute));
app.post("/escrow/:id/fund/confirm", requireAuth, h_wrap(escrowConfirmFundRoute));

// --- disputes (support) ---------------------------------------------------------
app.get("/disputes", requireAuth, requireRole("support", "dev"), h_wrap(listDisputes));
app.get("/disputes/:id", requireAuth, requireRole("support", "dev"), h_wrap(getDispute));
app.post("/disputes/:id/rule", requireAuth, requireRole("support", "dev"), h_wrap(ruleDispute));

// --- help desk tickets -------------------------------------------------------------
app.post("/tickets", requireAuth, h_wrap(createTicket));
app.get("/tickets", requireAuth, h_wrap(listTickets));
app.get("/tickets/:id", requireAuth, h_wrap(getTicket));
app.post("/tickets/:id/reply", requireAuth, h_wrap(replyTicket));
app.post("/tickets/:id/resolve", requireAuth, h_wrap(resolveTicket));

// --- leaderboard -----------------------------------------------------------------
app.get("/leaderboard", h_wrap(leaderboardRoute));

// --- admin --------------------------------------------------------------------------
app.get("/admin/health", requireAuth, requireRole("dev"), h_wrap(healthRoute));
app.get("/admin/reconciliation", requireAuth, requireRole("dev"), h_wrap(reconciliationRoute));
app.get("/admin/audit", requireAuth, requireRole("support", "dev"), h_wrap(auditRoute));
app.get("/admin/users", requireAuth, requireRole("support", "dev"), h_wrap(listUsers));
app.get("/admin/users/:id", requireAuth, requireRole("support", "dev"), h_wrap(userDetail));
app.post("/admin/users/:id/status", requireAuth, requireRole("support", "dev"), h_wrap(setUserStatus));
app.get("/admin/disputes", requireAuth, requireRole("support", "dev"), h_wrap(listDisputes));
app.get("/admin/jobs", requireAuth, requireRole("support", "dev"), h_wrap(async (req, res) => {
  const jobs = db.prepare("SELECT * FROM jobs ORDER BY id DESC").all();
  res.json({ jobs });
}));

app.get("/neon/status", h_wrap(async (_req, res) => {
  const { getUsersFromNeon, getJobsFromNeon, getTransactionsFromNeon } = await import("./neon.ts");
  const users = await getUsersFromNeon();
  const jobs = await getJobsFromNeon();
  const txs = await getTransactionsFromNeon();
  res.json({
    connected: true,
    provider: "Neon PostgreSQL (AWS us-east-2)",
    host: "ep-mute-bonus-b5bocw4s-pooler.c-7.us-east-2.aws.neon.tech",
    counts: {
      users: users.length,
      jobs: jobs.length,
      settled_transactions: txs.length
    },
    users: users.map(u => ({ id: u.id, wallet_address: u.wallet_address, role: u.role, status: u.status })),
    jobs: jobs.map(j => ({ id: j.id, title: j.title, status: j.status, usd_budget: j.usd_budget, sol_amount: j.sol_amount, escrow_address: j.escrow_address })),
    transactions: txs.map(t => ({ id: t.id, job_id: t.job_id, tx_signature: t.tx_signature, instruction_type: t.instruction_type, amount_lamports: t.amount_lamports, confirmed_at: t.confirmed_at })),
  });
}));

// Auto-sync SQLite to Neon on boot
import("./neon.ts").then(({ syncAllFromSqliteToNeon }) => syncAllFromSqliteToNeon()).catch(console.error);

// --- demo helpers (hackathon) ---------------------------------------------------------
app.get("/demo/actors", h_wrap(async (_req, res) => {
  const actors = await ensureDemoActors(false);
  res.json({ actors: actors.map(({ secretKeyB58, ...rest }) => ({ ...rest, secret_key_b58: secretKeyB58 })) });
}));

app.post("/demo/airdrop", h_wrap(async (req, res) => {
  const wallet = String(req.body?.wallet ?? "");
  let pub: web3.PublicKey;
  try {
    pub = new web3.PublicKey(wallet);
  } catch {
    throw bad("invalid wallet");
  }
  const result = await requestAirdrop(pub);
  res.json(result);
}));

app.get("/demo/balance/:wallet", h_wrap(async (req, res) => {
  const wallet = String(req.params.wallet ?? "");
  let pub: web3.PublicKey;
  try {
    pub = new web3.PublicKey(wallet);
  } catch {
    throw bad("invalid wallet");
  }
  const lamports = await conn.getBalance(pub, "confirmed");
  res.json({ wallet, lamports, sol: lamports / 1e9, explorer_url: explorerAccount(wallet) });
}));

app.post("/demo/sign-transfer", h_wrap(async (req, res) => {
  /**
   * Demo helper: signs a SystemProgram.transfer as a demo actor whose secret key
   * lives server-side (keys/demo_*.json). Only demo wallets can be used this way —
   * real user wallets never touch the backend.
   */
  const { wallet, to, lamports } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof wallet !== "string" || typeof to !== "string" || !Number.isInteger(Number(lamports))) {
    throw bad("wallet, to and integer lamports are required");
  }
  const actors = await ensureDemoActors(false);
  const actor = actors.find((a) => a.wallet === wallet);
  if (!actor) throw bad("not a demo wallet");
  const { loadDemoKeypairByWallet } = await import("./demo-keys.ts");
  const kp = loadDemoKeypairByWallet(wallet);
  const signed = await buildSignedTransfer(kp, new web3.PublicKey(String(to)), Number(lamports));
  res.json({ raw_tx_hex: signed.rawTx.toString("hex"), signature: signed.signature, explorer_url: signed.explorerUrl });
}));

app.post("/demo/fast-forward/:id", requireAuth, h_wrap(async (req, res) => {
  const jobId = parseIntOr(req.params.id, "job id");
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  if (!job) throw notFound("job not found");
  
  if (!job.freelancer_id) {
    db.prepare("UPDATE jobs SET freelancer_id = 2 WHERE id = ?").run(jobId);
    job.freelancer_id = 2;
  }
  
  const existingApp = db.prepare("SELECT id FROM job_applications WHERE job_id = ? AND freelancer_id = ?").get(jobId, job.freelancer_id);
  if (!existingApp) {
    db.prepare("INSERT INTO job_applications (job_id, freelancer_id, message, status) VALUES (?, ?, ?, 'accepted')").run(
      jobId, job.freelancer_id, "Ready to deliver high-quality deliverable."
    );
  } else {
    db.prepare("UPDATE job_applications SET status = 'accepted' WHERE job_id = ? AND freelancer_id = ?").run(jobId, job.freelancer_id);
  }
  
  const existingDel = db.prepare("SELECT id FROM deliveries WHERE job_id = ?").get(jobId);
  if (!existingDel) {
    db.prepare("INSERT INTO deliveries (job_id, version, note, attachment_urls, submitted_by) VALUES (?, 1, ?, ?, ?)").run(
      jobId,
      "Complete implementation with tests and deployment scripts ready for review.",
      JSON.stringify(["https://github.com/solana-developers/program-vault-pr-42"]),
      job.freelancer_id
    );
  }
  
  db.prepare("UPDATE jobs SET status = 'delivered' WHERE id = ?").run(jobId);
  const updatedJob = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  
  import("./neon.ts").then(({ syncJobToNeon }) => syncJobToNeon(updatedJob as any)).catch(() => {});
  
  res.json({ ok: true, job: updatedJob });
}));


// --- frontend --------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "../public")));
app.get(["/", "/landing"], (_req, res) => res.sendFile(path.join(__dirname, "../public/landing.html")));
app.get("/buyer", (_req, res) => res.sendFile(path.join(__dirname, "../public/buyer.html")));
app.get("/seller", (_req, res) => res.sendFile(path.join(__dirname, "../public/seller.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "../public/admin.html")));

// --- 404 + error handler ------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: "not found" }));

type Err = { status?: number; message?: string };
app.use((err: Err, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof err.status === "number" ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "internal error" });
});

// --- hourly leaderboard recompute ----------------------------------------------------------
setInterval(recomputeLeaderboard, 60 * 60 * 1000);

app.listen(config.port, () => {
  console.log(`Solana escrow marketplace backend on http://localhost:${config.port} (${config.chain})`);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection (caught):", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (caught):", err);
});

// wrap sync-or-async handlers so rejections reach the error middleware
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function h_wrap(fn: (req: any, res: any, next?: any) => unknown) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const out = fn(req, res, next);
      if (out instanceof Promise) out.catch(next);
    } catch (e) {
      next(e);
    }
  };
}
