import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { hashCode } from "./password.ts";

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, "app.db"));

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('client','freelancer','support','dev')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS client_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  organization TEXT NOT NULL DEFAULT '',
  business_description TEXT NOT NULL DEFAULT '',
  needs_summary TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS freelancer_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  headline TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  portfolio_ready INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS subdomains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id),
  name TEXT NOT NULL,
  UNIQUE (domain_id, name)
);

CREATE TABLE IF NOT EXISTS freelancer_domains (
  freelancer_id INTEGER NOT NULL REFERENCES users(id),
  subdomain_id INTEGER NOT NULL REFERENCES subdomains(id),
  PRIMARY KEY (freelancer_id, subdomain_id)
);

CREATE TABLE IF NOT EXISTS portfolio_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  freelancer_id INTEGER NOT NULL REFERENCES users(id),
  domain_id INTEGER REFERENCES domains(id),
  title TEXT NOT NULL DEFAULT '',
  media_url TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'link',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  freelancer_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  requirements TEXT NOT NULL,
  usd_budget REAL NOT NULL,
  sol_amount REAL,
  sol_lamports INTEGER,
  price_rate REAL,
  price_source TEXT,
  price_fetched_at TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created','funded','negotiating','agreed','in_progress','delivered',
    'released','rejected','closed_no_payout','disputed','held_detached'
  )),
  escrow_address TEXT,
  round INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  freelancer_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL DEFAULT '',
  offered_price_sol REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','withdrawn')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, freelancer_id)
);

CREATE TABLE IF NOT EXISTS negotiations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  offer_by INTEGER NOT NULL REFERENCES users(id),
  price_sol REAL NOT NULL,
  scope TEXT NOT NULL,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','countered','agreed')),
  client_agreed INTEGER NOT NULL DEFAULT 0,
  freelancer_agreed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Direct messages.
--
-- The messages table above is *job* scoped: it lives inside one contract's
-- thread. These
-- three tables carry the other half of the product — person-to-person chat, so a
-- client can talk to a freelancer before there is a job, or about something that
-- never becomes one. Threads are two-party by construction (no group fan-out).
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- Read state is a message id, not a timestamp: SQLite's datetime('now') only
  -- has second resolution, so two messages in the same second would both count
  -- as read and an unread badge would silently miss one.
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escrow_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  tx_signature TEXT UNIQUE NOT NULL,
  gemini_reference_id TEXT,
  instruction_type TEXT NOT NULL,
  amount_lamports INTEGER,
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  version INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  attachment_urls TEXT NOT NULL DEFAULT '[]',
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  raised_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ruled')),
  ruling TEXT,
  ruled_by INTEGER REFERENCES users(id),
  ruled_at TEXT
);

CREATE TABLE IF NOT EXISTS helpdesk_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER REFERENCES jobs(id),
  dispute_id INTEGER REFERENCES disputes(id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES helpdesk_tickets(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  is_staff INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  client_id INTEGER NOT NULL REFERENCES users(id),
  freelancer_id INTEGER NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action_type TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  target_id INTEGER,
  before_state TEXT,
  after_state TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leaderboard_scores (
  freelancer_id INTEGER PRIMARY KEY REFERENCES users(id),
  score REAL NOT NULL,
  breakdown_json TEXT NOT NULL DEFAULT '{}',
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_cache (
  pair TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- blockhash replay ledger (chain-layer)
CREATE TABLE IF NOT EXISTS usedBlockhashes (
  blockhash TEXT PRIMARY KEY,
  signature TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_buyer ON jobs(buyer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_freelancer ON jobs(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_apps_job ON job_applications(job_id);
CREATE INDEX IF NOT EXISTS idx_tx_job ON escrow_transactions(job_id);
CREATE INDEX IF NOT EXISTS idx_msg_job ON messages(job_id);
CREATE INDEX IF NOT EXISTS idx_cm_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_cm_conv ON conversation_members(conversation_id);
CREATE INDEX IF NOT EXISTS idx_dm_conv ON direct_messages(conversation_id, id);
`);

export type UserRole = "client" | "freelancer" | "support" | "dev";

export type User = {
  id: number;
  wallet_address: string;
  /** The account's *active* mode. Every existing `role === "freelancer"` check reads this. */
  role: UserRole;
  /** Every mode the account is entitled to switch into, comma-separated. Always contains `role`. */
  roles: string;
  status: "active" | "suspended";
  created_at: string;
};

/** Split the comma-separated `roles` column into a list, always including the active role. */
export function parseRoles(user: Pick<User, "role" | "roles">): UserRole[] {
  const known: UserRole[] = ["client", "freelancer", "support", "dev"];
  const out = new Set<UserRole>();
  for (const part of String(user.roles ?? "").split(",")) {
    const r = part.trim() as UserRole;
    if (known.includes(r)) out.add(r);
  }
  out.add(user.role);
  return known.filter((r) => out.has(r));
}

export function serializeRoles(roles: UserRole[]): string {
  const known: UserRole[] = ["client", "freelancer", "support", "dev"];
  return known.filter((r) => roles.includes(r)).join(",");
}

/** Modes a person may grant themselves. Staff modes are never self-service. */
export const SELF_SERVICE_ROLES: UserRole[] = ["client", "freelancer"];

export function getUser(id: number): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
  return row;
}

export function getUserByWallet(wallet: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE wallet_address = ?").get(wallet) as User | undefined;
}

export function createUser(wallet: string, role: UserRole, roles?: UserRole[]): User {
  db.prepare("INSERT INTO users (wallet_address, role, roles) VALUES (?, ?, ?)").run(
    wallet,
    role,
    serializeRoles(roles ?? [role]),
  );
  const u = getUserByWallet(wallet)!;
  import("./neon.ts").then(({ syncUserToNeon }) => syncUserToNeon(u)).catch(() => {});
  return u;
}

/**
 * Switch the account's active mode. The session JWT carries the role, so callers
 * must re-issue a token afterwards — this only writes the row.
 */
export function setActiveRole(userId: number, role: UserRole): User | undefined {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  const u = getUser(userId);
  if (u) import("./neon.ts").then(({ syncUserToNeon }) => syncUserToNeon(u)).catch(() => {});
  return u;
}

/** Grant a mode entitlement (e.g. "become a freelancer") without switching to it. */
export function grantRole(userId: number, role: UserRole): User | undefined {
  const user = getUser(userId);
  if (!user) return undefined;
  const next = parseRoles(user);
  if (!next.includes(role)) next.push(role);
  db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(serializeRoles(next), userId);
  const u = getUser(userId);
  if (u) import("./neon.ts").then(({ syncUserToNeon }) => syncUserToNeon(u)).catch(() => {});
  return u;
}

// Migration columns for freelancer_profiles
const fpCols = db.prepare("PRAGMA table_info(freelancer_profiles)").all() as { name: string }[];
const colNames = new Set(fpCols.map(c => c.name));
if (!colNames.has("degrees")) db.exec("ALTER TABLE freelancer_profiles ADD COLUMN degrees TEXT NOT NULL DEFAULT ''");
if (!colNames.has("languages")) db.exec("ALTER TABLE freelancer_profiles ADD COLUMN languages TEXT NOT NULL DEFAULT ''");
if (!colNames.has("age")) db.exec("ALTER TABLE freelancer_profiles ADD COLUMN age INTEGER NOT NULL DEFAULT 27");
if (!colNames.has("years_experience")) db.exec("ALTER TABLE freelancer_profiles ADD COLUMN years_experience INTEGER NOT NULL DEFAULT 5");
if (!colNames.has("hourly_rate_sol")) db.exec("ALTER TABLE freelancer_profiles ADD COLUMN hourly_rate_sol REAL NOT NULL DEFAULT 0.75");
if (!colNames.has("points")) db.exec("ALTER TABLE freelancer_profiles ADD COLUMN points INTEGER NOT NULL DEFAULT 450");

// Email lives on user_credentials so email/password login can match it exactly.
const credColNames = new Set(
  (db.prepare("PRAGMA table_info(user_credentials)").all() as { name: string }[]).map((c) => c.name)
);
if (!credColNames.has("email")) db.exec("ALTER TABLE user_credentials ADD COLUMN email TEXT");

// Auth columns on users: verification flag + token version (for revocation).
const userCols = new Set(
  (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name)
);
if (!userCols.has("email_verified")) {
  db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  // Accounts that predate verification are trusted; only new signups start unverified.
  db.exec("UPDATE users SET email_verified = 1");
}
if (!userCols.has("token_version")) {
  db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
}
// Dual-role entitlement. `role` stays the *active* mode so every existing
// `role === "freelancer"` check keeps working untouched; `roles` records what
// the account may switch between. Backfilled from the pre-existing single role.
if (!userCols.has("roles")) {
  db.exec("ALTER TABLE users ADD COLUMN roles TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE users SET roles = role WHERE roles = '' OR roles IS NULL");
}

// One-time tokens (email verification / password reset) and their audit trail.
db.exec(`
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('email_verify','password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  event TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  identifier TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_attempt INTEGER NOT NULL
);
`);

// Create user_notifications table
db.exec(`
CREATE TABLE IF NOT EXISTS user_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER REFERENCES jobs(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','dismissed','accepted','declined')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/**
 * Nyaya — the case layer behind the evidence-to-ruling engine.
 *
 * `cases` is deliberately rail-agnostic. An escrow dispute and a UPI fraud
 * report differ in who owes what and in which rulebook governs, but they are the
 * same shape to the engine: evidence in, ruling out. The rail-specific facts
 * live in `payload_json` rather than in a dozen nullable columns, because the
 * second rail arrived after the first and a third is expected.
 *
 * Notice what is *not* stored here: the deadline. `clock_started_at` records when
 * the governing clock started — the unauthorised transaction's date on the UPI
 * rail, the escalation date on an escrow dispute — and the due date is derived
 * from it on read (see `cases.ts`). Persisting a computed deadline as well would
 * give the row and the rulebook two independent chances to disagree, and the one
 * a judge reads would be the stale one.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rail TEXT NOT NULL CHECK (rail IN ('escrow','upi')),
  title TEXT NOT NULL,
  -- Who the case is against/for: a user id, a wallet, or a UPI handle.
  party_ref TEXT NOT NULL DEFAULT '',
  amount REAL,
  currency TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ruled','confirmed','closed')),
  -- When the governing clock started, in UTC. NULL means "no clock I can compute
  -- from", which the deadline layer treats as "no countdown" rather than
  -- guessing a start date.
  clock_started_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per piece of evidence. body is the text we reason over; ref points
-- at the artefact it came from (an /uploads path, a transaction signature, a
-- message id), so a ruling can always be traced back to what it read.
CREATE TABLE IF NOT EXISTS case_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  source TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','upload','message','chain','document')),
  body TEXT NOT NULL DEFAULT '',
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A ruling is a precedent the moment it is written: the next case on the same
-- rail cites it. The cached column records whether the model's answer came from a live
-- call or from the offline cache, so a ruling can never quietly claim to be
-- fresher than it is.
CREATE TABLE IF NOT EXISTS rulings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  rulebook TEXT NOT NULL,
  decision TEXT NOT NULL,
  confidence REAL,
  reasoning TEXT NOT NULL DEFAULT '',
  deadline_at TEXT,
  liability_band TEXT,
  model TEXT,
  cached INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ruling_citations (
  ruling_id INTEGER NOT NULL REFERENCES rulings(id),
  cited_ruling_id INTEGER NOT NULL REFERENCES rulings(id),
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (ruling_id, cited_ruling_id)
);

-- Responses from a real provider call, keyed by a hash of the exact input.
--
-- TTL-less on purpose, unlike price_cache: a price is only true for a moment,
-- but a model's answer to *identical* input does not expire. That makes this
-- table the offline backstop for the demo — running a case that was already run
-- answers from cache with no network at all, and it replays the response the
-- model actually produced rather than a scripted stand-in.
CREATE TABLE IF NOT EXISTS llm_cache (
  prompt_hash TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cases_rail ON cases(rail, status);
CREATE INDEX IF NOT EXISTS idx_case_evidence_case ON case_evidence(case_id);
CREATE INDEX IF NOT EXISTS idx_rulings_case ON rulings(case_id);
CREATE INDEX IF NOT EXISTS idx_rulings_rulebook ON rulings(rulebook);

-- Retrieval index for preceding rulings.
--
-- Only the body column is indexed; every other column is UNINDEXED on purpose.
-- FTS5 will happily match a query token against any indexed column, so leaving
-- the decision indexed would mean a case whose evidence merely contains the word
-- "freelancer" scores a hit against every ruling that released one. The columns
-- are kept for filtering and display, and the content comes back from the
-- rulings table itself — the index is a pointer, never the record.
CREATE VIRTUAL TABLE IF NOT EXISTS ruling_fts USING fts5(
  ruling_id UNINDEXED,
  case_id UNINDEXED,
  rulebook UNINDEXED,
  decision UNINDEXED,
  liability_band UNINDEXED,
  body
);

-- Evidence that tried to instruct the arbiter.
--
-- The row it came from is never modified: an operator reviewing the case must
-- see exactly what the party wrote. This table is the record of what was
-- withheld from the model and why, alongside the snippet that triggered it.
CREATE TABLE IF NOT EXISTS evidence_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  ruling_id INTEGER REFERENCES rulings(id),
  evidence_ref TEXT NOT NULL DEFAULT '',
  rule_id TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quarantine_case ON evidence_quarantine(case_id);
`);

// A case whose evidence contained instruction-shaped text is flagged rather than
// refused: the report still deserves a decision, and the operator needs to know
// that something in it tried to steer the arbiter.
const caseCols = new Set(
  (db.prepare("PRAGMA table_info(cases)").all() as { name: string }[]).map((c) => c.name),
);
if (!caseCols.has("suspicious")) {
  db.exec("ALTER TABLE cases ADD COLUMN suspicious INTEGER NOT NULL DEFAULT 0");
}

export function seedDefaultCredentials(): void {
  const accounts = [
    { username: "buyer", password: "buyer123", role: "client" },
    { username: "seller", password: "seller123", role: "freelancer" },
    { username: "admin", password: "admin123", role: "dev" },
  ] as const;

  for (const acc of accounts) {
    // Look the demo account up by the username it owns, NOT by "first user with
    // this role". `role` stopped being a stable key once an account could switch
    // modes: the moment the demo buyer freelanced, "first client" resolved to a
    // real signup and this insert tried to claim an already-taken username,
    // which the ON CONFLICT (user_id) clause does not cover — so the next boot
    // died on the username unique index.
    let user = db
      .prepare("SELECT user_id AS id FROM user_credentials WHERE username = ?")
      .get(acc.username) as { id: number } | undefined;
    if (!user) {
      // First uncredentialed account of that role still works as a fallback.
      user = db
        .prepare(
          `SELECT u.id FROM users u
             LEFT JOIN user_credentials c ON c.user_id = u.id
            WHERE u.role = ? AND c.user_id IS NULL
            ORDER BY u.id ASC LIMIT 1`
        )
        .get(acc.role) as { id: number } | undefined;
    }
    if (user) {
      db.prepare(`
        INSERT INTO user_credentials (user_id, username, password, email)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, password = excluded.password
      `).run(user.id, acc.username, hashCode(acc.password));
      // Demo accounts are pre-verified so the hackathon logins keep working.
      db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(user.id);

      // Seed rich freelancer profile for seller
      if (acc.role === "freelancer") {
        db.prepare(`
          INSERT INTO freelancer_profiles (user_id, headline, bio, portfolio_ready, degrees, languages, age, years_experience, hourly_rate_sol, points)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET
            headline = excluded.headline,
            bio = excluded.bio,
            degrees = excluded.degrees,
            languages = excluded.languages,
            age = excluded.age,
            years_experience = excluded.years_experience,
            hourly_rate_sol = excluded.hourly_rate_sol,
            points = excluded.points,
            portfolio_ready = 1
        `).run(
          user.id,
          "Solana Core Developer & Anchor Specialist",
          "Full-stack Web3 engineer specializing in Solana Anchor programs, high-throughput escrow architectures, and Rust smart contracts. Over 100+ devnet contracts deployed.",
          "B.S. in Computer Science (Stanford University), Certified Solana Foundation Anchor Engineer",
          "Rust, TypeScript, Go, Solidity, Python, English",
          27,
          5,
          0.75,
          450
        );
      }
    }
  }
}
if (config.seedDemoAccounts) {
  // Seeding is a convenience, never a boot prerequisite: a failed seed must not
  // take the whole server down with it.
  try {
    seedDefaultCredentials();
  } catch (err) {
    console.error("[db] demo account seeding failed (continuing):", err);
  }
} else {
  console.log("[db] demo account seeding disabled (SEED_DEMO_ACCOUNTS=false)");
}
