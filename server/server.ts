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
import type { RequestHandler } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as web3 from "@solana/web3.js";
import { db } from "./db.ts";
import { config } from "./config.ts";
import {
  challengeRoute,
  verifyRoute,
  loginRoute,
  signupRoute,
  socialSignupRoute,
  adminSignupRoute,
  logoutRoute,
  verifyEmailRoute,
  resendVerificationRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  changePasswordRoute,
  meRoute,
  setModeRoute,
  addRoleRoute,
  requireAuth,
  requireRole,
  maybeAuth,
  type AuthedRequest,
} from "./auth.ts";
import { auth0LoginRoute, auth0CallbackRoute, auth0HandoffRoute, auth0Meta, auth0LogoutRoute } from "./auth0.ts";
import {
  listThreadsRoute,
  openThreadRoute,
  listMessagesRoute,
  sendMessageRoute,
  markReadRoute,
  unreadRoute,
} from "./messages.ts";
import { uploadRoute, uploadsDir, uploadHeaders, uploadMeta } from "./uploads.ts";
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
  removePortfolioItem,
  setFreelancerSkills,
  listMyPortfolio,
  publishProfile,
  myProfileRoute,
  searchFreelancers,
  getFreelancerProfileRoute,
  updateFreelancerProfileRoute,
  redeemPointsRoute,
  getNotificationsRoute,
  respondNotificationRoute,
} from "./profiles.ts";
import { listDisputes, getDispute, ruleDispute, disputeEvidence } from "./disputes.ts";
import {
  listCasesRoute,
  createCaseRoute,
  getCaseRoute,
  updateCaseRoute,
  deleteCaseRoute,
} from "./cases.ts";
import {
  ruleCaseRoute,
  confirmCaseRoute,
  getRulingRoute,
  listRulingsRoute,
  listRulebooksRoute,
} from "./arbiter.ts";
import { createTicket, listTickets, getTicket, replyTicket, resolveTicket } from "./tickets.ts";
import { leaderboardRoute, recomputeLeaderboard } from "./leaderboard.ts";
import { healthRoute, reconciliationRoute, auditRoute, listUsers, setUserStatus, userDetail } from "./admin.ts";
import { getSolUsdRate } from "./gemini.ts";
import { bad, tooMany, parseIntOr, notFound } from "./util.ts";
import { securityHeaders, cors, rateLimit } from "./security.ts";
import { platformKeypair } from "./keys.ts";
import { buildSignedTransfer, conn } from "./solana.ts";
import { explorerAccount } from "./config.ts";
import { ensureDemoActors, seedTaxonomy } from "./seed.ts";
import { requestAirdrop } from "./solana.ts";
import type { User } from "./db.ts";

export const app = express();
app.disable("x-powered-by");
// Resolve the real client IP when running behind a reverse proxy / load balancer.
app.set("trust proxy", true);
app.use(securityHeaders);
app.use(cors);

// --- uploads ------------------------------------------------------------------
// Deliverable files carry real image/video bytes, so this route needs a far larger
// body limit than the global 1mb JSON parser. It therefore has to be registered
// BEFORE that parser — otherwise the global one consumes the request and answers
// 413 before this handler is ever reached. It gets its own stricter rate limit
// instead of the broad one, since uploads are the most expensive thing we accept.
const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  message: "too many uploads, please slow down",
});
app.post("/uploads", requireAuth, uploadLimiter, express.json({ limit: "16mb" }), h_wrap(uploadRoute));
app.use(
  "/uploads",
  express.static(uploadsDir, {
    index: false,
    dotfiles: "deny",
    maxAge: "7d",
    setHeaders: (res, filePath) => uploadHeaders(res, filePath),
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "500kb" }));

// --- rate limiting ------------------------------------------------------------
// Broad limiter for the whole API.
app.use(rateLimit({ windowMs: 60_000, max: 300, message: "too many requests, please slow down" }));

// Strict limiter for credential endpoints (brute-force / credential stuffing).
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  message: "too many authentication attempts, please try again later",
  keyExtra: (req) => String(req.body?.email ?? req.body?.username ?? ""),
});
void tooMany;

// --- auth ---------------------------------------------------------------
app.post("/auth/challenge", h_wrap(challengeRoute));
app.post("/auth/verify", h_wrap(verifyRoute));
app.post("/auth/login", authLimiter, h_wrap(loginRoute));
app.post("/auth/signup", authLimiter, h_wrap(signupRoute));
app.post("/auth/social-signup", authLimiter, h_wrap(socialSignupRoute));
app.post("/auth/admin-signup", authLimiter, h_wrap(adminSignupRoute));
app.post("/auth/logout", requireAuth, h_wrap(logoutRoute));
app.post("/auth/verify-email", authLimiter, h_wrap(verifyEmailRoute));
app.post("/auth/verify-email/resend", requireAuth, h_wrap(resendVerificationRoute));
app.post("/auth/forgot-password", authLimiter, h_wrap(forgotPasswordRoute));
app.post("/auth/reset-password", authLimiter, h_wrap(resetPasswordRoute));
app.post("/auth/change-password", requireAuth, h_wrap(changePasswordRoute));
app.get("/auth/me", requireAuth, h_wrap(meRoute));
// Dual-role accounts: switch the active mode, or grant themselves the other side
// ("become a freelancer" / "start hiring"). Both re-issue the session token.
app.post("/auth/mode", requireAuth, h_wrap(setModeRoute));
app.post("/auth/roles", requireAuth, h_wrap(addRoleRoute));
// Auth0 Universal Login (hosted sign-in). Inert until AUTH0_* is configured.
app.get("/auth/auth0/login", h_wrap(auth0LoginRoute));
app.get("/auth/auth0/callback", h_wrap(auth0CallbackRoute));
// AUTH0_CALLBACK_URL may name a different path (Auth0's Express quickstart
// whitelists /callback), so the configured path answers as well. The two must
// stay in step or the login page would send Auth0 to a URL this app does not serve.
if (config.auth0.callbackPath !== "/auth/auth0/callback") {
  app.get(config.auth0.callbackPath, h_wrap(auth0CallbackRoute));
}
app.post("/auth/auth0/handoff", authLimiter, h_wrap(auth0HandoffRoute));
app.get("/auth/auth0/logout", h_wrap(auth0LogoutRoute));

// --- direct messages ------------------------------------------------------
// Person-to-person chat. Membership is resolved from the caller's own session on
// every request, so a thread id borrowed from someone else's inbox is not found.
const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: "you are sending messages too quickly",
});
app.get("/conversations", requireAuth, h_wrap(listThreadsRoute));
app.post("/conversations", requireAuth, h_wrap(openThreadRoute));
app.get("/conversations/:id/messages", requireAuth, h_wrap(listMessagesRoute));
app.post("/conversations/:id/messages", requireAuth, chatLimiter, h_wrap(sendMessageRoute));
app.post("/conversations/:id/read", requireAuth, h_wrap(markReadRoute));
app.get("/me/unread", requireAuth, h_wrap(unreadRoute));

// --- meta -----------------------------------------------------------------
app.get("/meta/taxonomy", taxonomyRoute);
// Which sign-in methods this deployment offers; the login page renders from it.
app.get("/meta/auth", (_req, res) => {
  res.json({
    auth0: auth0Meta(),
    demo: { enabled: config.seedDemoAccounts },
  });
});
// What the client may upload, so the dropzone states the real limit rather than a
// hardcoded guess that drifts from the server.
app.get("/meta/uploads", (_req, res) => {
  res.json(uploadMeta);
});
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
app.delete("/me/portfolio/:id", requireAuth, h_wrap(removePortfolioItem));
app.post("/me/portfolio/publish", requireAuth, h_wrap(publishProfile));
app.post("/me/freelancer/skills", requireAuth, h_wrap(setFreelancerSkills));
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

// --- nyaya: the case layer behind the evidence-to-ruling engine --------------------
//
// Staff-only, exactly like the dispute queue it generalises. A case carries
// counterparty evidence and, once the arbiter lands, its confirmation moves
// money — so it gets the same gate as ruling a dispute, not a broader one.
app.get("/arbiter/cases", requireAuth, requireRole("support", "dev"), h_wrap(listCasesRoute));
// The rails and their remedies, so the console labels a decision with the words
// the rulebook defines instead of a second, drifting copy of the ids.
app.get("/arbiter/rulebooks", requireAuth, requireRole("support", "dev"), h_wrap(listRulebooksRoute));
app.post("/arbiter/cases", requireAuth, requireRole("support", "dev"), h_wrap(createCaseRoute));
app.get("/arbiter/cases/:id", requireAuth, requireRole("support", "dev"), h_wrap(getCaseRoute));
// Every ruling the case has produced, with its citations resolved and its
// quarantine record — the console renders one case from this single call.
app.get("/arbiter/cases/:id/rulings", requireAuth, requireRole("support", "dev"), h_wrap(listRulingsRoute));
app.patch("/arbiter/cases/:id", requireAuth, requireRole("support", "dev"), h_wrap(updateCaseRoute));
// Deleting is destructive and retires a case for good, so it is dev-only.
app.delete("/arbiter/cases/:id", requireAuth, requireRole("dev"), h_wrap(deleteCaseRoute));
// Ruling only ever recommends. Confirming is the separate, deliberate step that
// applies the remedy through the rail's own money path — the same gate as ruling
// a dispute by hand, because it is the same decision.
app.post("/arbiter/cases/:id/rule", requireAuth, requireRole("support", "dev"), h_wrap(ruleCaseRoute));
app.post("/arbiter/cases/:id/confirm", requireAuth, requireRole("support", "dev"), h_wrap(confirmCaseRoute));
app.get("/arbiter/rulings/:id", requireAuth, requireRole("support", "dev"), h_wrap(getRulingRoute));

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

// The Postgres mirror's contents. Staff-only: it is a full dump of every wallet
// address, contract and settled transaction, which is the same material
// /admin/users and /admin/jobs already gate — an unauthenticated route returning
// it was simply a way around those gates. The provider label now comes from
// configuration too, rather than naming a host in the source.
app.get("/neon/status", requireAuth, requireRole("support", "dev"), h_wrap(async (_req, res) => {
  const { getUsersFromNeon, getJobsFromNeon, getTransactionsFromNeon, getCaseLawFromNeon, neonConfigured } =
    await import("./neon.ts");
  // A mirror that is down is the single most useful thing this page can report, so a
  // failed read degrades to an empty list plus an error field instead of a 500 that
  // says nothing about why. Every count below is derived from these lists, so they
  // follow the degradation rather than claiming rows that were never read.
  let readError = "";
  const read = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      readError ||= err instanceof Error ? err.message : String(err);
      return fallback;
    }
  };
  const users = await read<any[]>(getUsersFromNeon, []);
  const jobs = await read<any[]>(getJobsFromNeon, []);
  const txs = await read<any[]>(getTransactionsFromNeon, []);
  // Nyaya's own record, mirrored. Without this the status view was a mirror of the
  // marketplace that said nothing about the case law the marketplace now produces.
  const cases = await read<any[]>(getCaseLawFromNeon, []);
  res.json({
    connected: neonConfigured,
    provider: neonConfigured ? "PostgreSQL (mirror)" : "not configured",
    host: config.databaseHost,
    // Only present when a read failed, so a healthy mirror carries no null field.
    ...(readError ? { error: readError } : {}),
    counts: {
      users: users.length,
      jobs: jobs.length,
      settled_transactions: txs.length,
      cases: cases.length,
      rulings: cases.reduce((sum, c) => sum + Number(c.rulings || 0), 0),
      citations: cases.reduce((sum, c) => sum + Number(c.citations || 0), 0)
    },
    case_law: cases.map(c => ({
      id: c.id,
      rail: c.rail,
      status: c.status,
      title: c.title,
      rulings: Number(c.rulings || 0),
      citations: Number(c.citations || 0),
      suspicious: Number(c.suspicious || 0) === 1
    })),
    users: users.map(u => ({ id: u.id, wallet_address: u.wallet_address, role: u.role, status: u.status })),
    jobs: jobs.map(j => ({ id: j.id, title: j.title, status: j.status, usd_budget: j.usd_budget, sol_amount: j.sol_amount, escrow_address: j.escrow_address })),
    transactions: txs.map(t => ({ id: t.id, job_id: t.job_id, tx_signature: t.tx_signature, instruction_type: t.instruction_type, amount_lamports: t.amount_lamports, confirmed_at: t.confirmed_at })),
  });
}));

// Demo marketplace content on boot: profiles, skills and portfolios for the seeded
// freelancers. Without it a fresh database renders a directory with one bare card
// and a profile with an empty portfolio grid.
import("./seed.ts")
  .then(({ seedDemoPortfolios }) => seedDemoPortfolios())
  .catch((err) => console.error("seedDemoPortfolios failed (continuing):", err));

// Auto-sync SQLite to Neon on boot (never blocks listen).
import("./neon.ts").then((m) => {
  const { syncAllFromSqliteToNeonFull, syncAllFromSqliteToNeonBootOnly } = m;
  // Lightweight user sync first so the server can listen quickly.
  syncAllFromSqliteToNeonBootOnly().catch(console.error);
  // Then the rest (jobs/transactions) in the background, every 10 minutes.
  syncAllFromSqliteToNeonFull().catch(console.error);
  setInterval(() => syncAllFromSqliteToNeonFull().catch(console.error), 10 * 60 * 1000);
}).catch(console.error);

// --- demo helpers (hackathon) ---------------------------------------------------------
//
// These are the most powerful routes in the app: they name the seeded wallets, hand
// back their private keys and will sign a transfer from any of them on request. They
// exist so the browser personas can work without a wallet extension, which is a
// development affordance and nothing else — so they are simply not registered when
// NODE_ENV=production, rather than being protected by a check someone could forget.
const demoOnly: RequestHandler = (_req, _res, next) => {
  if (config.isProduction) return next(notFound("not found"));
  next();
};

app.get("/demo/actors", demoOnly, h_wrap(async (_req, res) => {
  const actors = await ensureDemoActors(false);
  res.json({
    actors: actors.map(({ secretKeyB58, ...rest }) =>
      // Belt and braces with the route gate: the key only ever leaves the server
      // when the deployment has explicitly opted in to exposing it.
      config.exposeDemoSecretKeys ? { ...rest, secret_key_b58: secretKeyB58 } : rest,
    ),
  });
}));

app.post("/demo/airdrop", demoOnly, h_wrap(async (req, res) => {
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

app.get("/demo/balance/:wallet", demoOnly, h_wrap(async (req, res) => {
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

app.post("/demo/sign-transfer", demoOnly, h_wrap(async (req, res) => {
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

app.post("/demo/fast-forward/:id", demoOnly, requireAuth, h_wrap(async (req, res) => {
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
// The old dev panel (/index.html) is retired — its job is split across the role
// portals and the landing page. These redirects sit in front of the static mount
// so the legacy URLs (and the .html paths its header linked to) still resolve.
// The role portals (buyer/seller) are gone on purpose: there is one signed-in app
// whose nav adapts to the account, so there is nothing to "switch" between.
const LEGACY_PAGES: [string, string][] = [
  ["/index.html", "/"],
  ["/landing.html", "/"],
  ["/buyer.html", "/app"],
  ["/seller.html", "/app"],
  ["/admin.html", "/operator"],
  ["/buyer", "/app"],
  ["/seller", "/app"],
  ["/admin", "/operator"],
  ["/talent", "/browse"],
  ["/profile", "/me"],
];
for (const [from, to] of LEGACY_PAGES) app.get(from, (_req, res) => res.redirect(301, to));

// `index: false` so "/" is served by the landing route below, not by a file.
app.use(express.static(path.join(__dirname, "../client"), { index: false }));
app.get(["/", "/landing"], (_req, res) => res.sendFile(path.join(__dirname, "../client/landing.html")));
// The team used to be a page of its own (`/creators`); it now lives at the end of
// the landing page under `#creators`, so old links land on the roster itself.
app.get("/creators", (_req, res) => res.redirect(301, "/#creators"));
app.get(["/login", "/signup"], (_req, res) => res.sendFile(path.join(__dirname, "../client/login.html")));

// One application shell. Every view inside it is hash-routed, so adding a screen
// never means adding a server route (or a new static HTML file).
const APP_SHELL_PATHS = [
  "/app",
  "/dashboard",
  "/me",
  "/messages",
  "/browse",
  "/work",
  "/operator",
  "/freelancer/:id",
];
for (const p of APP_SHELL_PATHS) {
  app.get(p, (_req, res) => res.sendFile(path.join(__dirname, "../client/app.html")));
}

// --- 404 + error handler ------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: "not found" }));

type Err = { status?: number; message?: string };
app.use((err: Err, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof err.status === "number" ? err.status : 500;
  if (status >= 500) console.error(err);
  // Never leak internal error details to clients in production.
  const message =
    status >= 500 && config.isProduction
      ? "internal server error"
      : err.message || "internal error";
  res.status(status).json({ error: message });
});

// --- hourly leaderboard recompute ----------------------------------------------------------
setInterval(recomputeLeaderboard, 60 * 60 * 1000);

/**
 * A hosted deployment fails in ways a laptop never does: the filesystem is
 * replaced on every redeploy, the origin is not localhost, and there may be no
 * way to create a staff account at all. Every one of these is legal
 * configuration — the app runs — so none can be an error, and each is worth
 * saying at boot instead of discovering it after a demo.
 */
function warnAboutDeployment(): void {
  if (!config.isProduction) return;
  const notes: string[] = [];

  if (config.storageIsEphemeral) {
    notes.push(
      `DATA_DIR/KEYS_DIR are relative (${config.dataDir}, ${config.keysDir}), so the ledger ` +
        `and the platform wallet live inside the deploy directory. Hosts commonly replace ` +
        `that on redeploy — mount a volume and point both at it, or the next deploy drops ` +
        `every case and issues a new platform wallet.`,
    );
  }
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(config.appOrigin)) {
    notes.push(
      `APP_ORIGIN is ${config.appOrigin}: SIWS messages, links and the Auth0 callback will ` +
        `name a host visitors cannot reach. Set it to the public URL.`,
    );
  }
  if (!config.staffInviteCode) {
    notes.push(
      "STAFF_INVITE_CODE is unset, so no support or dev account can be created and the " +
        "operator console and case docket are unreachable. Set a random code and send it as " +
        "the x-staff-invite header when signing in as staff.",
    );
  }
  if (config.seedDemoAccounts) {
    notes.push(
      "SEED_DEMO_ACCOUNTS is on in production: the seeded accounts use passwords published " +
        "in this repository, so anyone who has read it can sign in as staff.",
    );
  }
  if (!config.llm.configured) {
    notes.push(
      "LLM_API_KEY is unset, so Nyaya cannot reach a model: it will replay a cached ruling " +
        "for an input it has already seen and report itself unavailable for anything else.",
    );
  }

  if (!notes.length) return;
  console.warn("\nDeployment notes:");
  for (const note of notes) console.warn(`  - ${note}`);
  console.warn("");
}

const server = app.listen(config.port, () => {
  console.log(
    `Solana escrow marketplace backend on ${config.appOrigin} (${config.chain}, ${config.nodeEnv})`,
  );
  // Auth0 sends the browser back to the whitelisted callback URL, not to whatever
  // origin this process happens to serve. When those disagree — a preview on another
  // port, a proxy in front — the sign-in completes at Auth0 and then dies on a server
  // that is not this one, with no error anywhere. Say it at boot; the login page says
  // it too.
  const mismatch = config.auth0.originMismatch;
  if (config.auth0.configured && mismatch) {
    console.warn(
      `Auth0 callback origin mismatch: this server serves ${mismatch.servingOrigin} but ` +
        `AUTH0_CALLBACK_URL points at ${mismatch.callbackOrigin} — hosted sign-in will ` +
        `return to ${mismatch.callbackOrigin} and no session will be issued here.`,
    );
  }
  warnAboutDeployment();
});

// --- graceful shutdown --------------------------------------------------------
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received — shutting down gracefully…`);
  server.close(() => console.log("HTTP server closed."));
  try {
    const { pgPool } = await import("./neon.ts");
    await pgPool.end();
    console.log("Postgres pool closed.");
  } catch {
    /* pool may never have been used */
  }
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection (caught):", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (caught):", err);
});

// wrap sync-or-async handlers so rejections reach the error middleware
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function h_wrap(fn: (req: any, res: any, next?: any) => unknown) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const out = fn(req, res, next);
      if (out instanceof Promise) out.catch(next);
    } catch (e) {
      next(e);
    }
  };
}
