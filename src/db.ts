import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

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
`);

export type User = {
  id: number;
  wallet_address: string;
  role: "client" | "freelancer" | "support" | "dev";
  status: "active" | "suspended";
  created_at: string;
};

export function getUser(id: number): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
  return row;
}

export function getUserByWallet(wallet: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE wallet_address = ?").get(wallet) as User | undefined;
}

export function createUser(wallet: string, role: User["role"]): User {
  db.prepare("INSERT INTO users (wallet_address, role) VALUES (?, ?)").run(wallet, role);
  const u = getUserByWallet(wallet)!;
  import("./neon.ts").then(({ syncUserToNeon }) => syncUserToNeon(u)).catch(() => {});
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

export function seedDefaultCredentials(): void {
  const accounts = [
    { username: "buyer", password: "buyer123", role: "client" },
    { username: "seller", password: "seller123", role: "freelancer" },
    { username: "admin", password: "admin 123", role: "dev" },
  ];

  for (const acc of accounts) {
    const user = db.prepare("SELECT id FROM users WHERE role = ? ORDER BY id ASC LIMIT 1").get(acc.role) as { id: number } | undefined;
    if (user) {
      db.prepare(`
        INSERT INTO user_credentials (user_id, username, password)
        VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, password = excluded.password
      `).run(user.id, acc.username, acc.password);

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
seedDefaultCredentials();
