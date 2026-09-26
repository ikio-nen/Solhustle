import pg from "pg";
import { db } from "./db.ts";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://neondb_owner:npg_cu51nKWfRsQI@ep-mute-bonus-b5bocw4s-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";

export const pgPool = new pg.Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function initNeonSchema(): Promise<void> {
  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        wallet_address TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('client','freelancer','support','dev')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_credentials (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
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
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subdomains (
        id SERIAL PRIMARY KEY,
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
        id SERIAL PRIMARY KEY,
        freelancer_id INTEGER NOT NULL REFERENCES users(id),
        domain_id INTEGER REFERENCES domains(id),
        title TEXT NOT NULL DEFAULT '',
        media_url TEXT NOT NULL,
        media_type TEXT NOT NULL DEFAULT 'link',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        buyer_id INTEGER NOT NULL REFERENCES users(id),
        freelancer_id INTEGER REFERENCES users(id),
        title TEXT NOT NULL,
        requirements TEXT NOT NULL,
        usd_budget DOUBLE PRECISION NOT NULL,
        sol_amount DOUBLE PRECISION,
        sol_lamports BIGINT,
        price_rate DOUBLE PRECISION,
        price_source TEXT,
        price_fetched_at TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        escrow_address TEXT,
        round INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS job_applications (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        freelancer_id INTEGER NOT NULL REFERENCES users(id),
        message TEXT NOT NULL DEFAULT '',
        offered_price_sol DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_id, freelancer_id)
      );

      CREATE TABLE IF NOT EXISTS negotiations (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        offer_by INTEGER NOT NULL REFERENCES users(id),
        price_sol DOUBLE PRECISION NOT NULL,
        scope TEXT NOT NULL,
        deadline TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        client_agreed INTEGER NOT NULL DEFAULT 0,
        freelancer_agreed INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        sender_id INTEGER NOT NULL REFERENCES users(id),
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS escrow_transactions (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        tx_signature TEXT UNIQUE NOT NULL,
        gemini_reference_id TEXT,
        instruction_type TEXT NOT NULL,
        amount_lamports BIGINT,
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        version INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        attachment_urls TEXT NOT NULL DEFAULT '[]',
        submitted_by INTEGER NOT NULL REFERENCES users(id),
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS disputes (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        raised_by INTEGER NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        ruling TEXT,
        ruled_by INTEGER REFERENCES users(id),
        ruled_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS ratings (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
        client_id INTEGER NOT NULL REFERENCES users(id),
        freelancer_id INTEGER NOT NULL REFERENCES users(id),
        stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
        comment TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS price_cache (
        pair TEXT PRIMARY KEY,
        rate DOUBLE PRECISION NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        job_id INTEGER REFERENCES jobs(id),
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE freelancer_profiles ADD COLUMN IF NOT EXISTS degrees TEXT NOT NULL DEFAULT '';
      ALTER TABLE freelancer_profiles ADD COLUMN IF NOT EXISTS languages TEXT NOT NULL DEFAULT '';
      ALTER TABLE freelancer_profiles ADD COLUMN IF NOT EXISTS age INTEGER NOT NULL DEFAULT 27;
      ALTER TABLE freelancer_profiles ADD COLUMN IF NOT EXISTS years_experience INTEGER NOT NULL DEFAULT 5;
      ALTER TABLE freelancer_profiles ADD COLUMN IF NOT EXISTS hourly_rate_sol DOUBLE PRECISION NOT NULL DEFAULT 0.75;
      ALTER TABLE freelancer_profiles ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 450;
    `);
    console.log("Neon Postgres tables verified.");
  } finally {
    client.release();
  }
}

export async function syncUserToNeon(user: { id?: number; wallet_address: string; role: string; status?: string }): Promise<void> {
  try {
    if (user.id) {
      await pgPool.query(
        `INSERT INTO users (id, wallet_address, role, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (wallet_address) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status`,
        [user.id, user.wallet_address, user.role, user.status || "active"]
      );
    } else {
      await pgPool.query(
        `INSERT INTO users (wallet_address, role, status)
         VALUES ($1, $2, $3)
         ON CONFLICT (wallet_address) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status`,
        [user.wallet_address, user.role, user.status || "active"]
      );
    }
  } catch (err) {
    console.error("Neon syncUser error:", err);
  }
}

export async function syncJobToNeon(job: {
  id: number;
  buyer_id: number;
  freelancer_id?: number | null;
  title: string;
  requirements: string;
  usd_budget: number;
  sol_amount?: number | null;
  sol_lamports?: number | null;
  price_rate?: number | null;
  price_source?: string | null;
  price_fetched_at?: string | null;
  status: string;
  escrow_address?: string | null;
  round?: number;
}): Promise<void> {
  try {
    await pgPool.query(
      `INSERT INTO jobs (id, buyer_id, freelancer_id, title, requirements, usd_budget, sol_amount, sol_lamports, price_rate, price_source, price_fetched_at, status, escrow_address, round, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         freelancer_id = EXCLUDED.freelancer_id,
         escrow_address = EXCLUDED.escrow_address,
         round = EXCLUDED.round,
         updated_at = NOW()`,
      [
        job.id,
        job.buyer_id,
        job.freelancer_id || null,
        job.title,
        job.requirements,
        job.usd_budget,
        job.sol_amount || null,
        job.sol_lamports || null,
        job.price_rate || null,
        job.price_source || null,
        job.price_fetched_at || null,
        job.status,
        job.escrow_address || null,
        job.round || 1,
      ]
    );
  } catch (err) {
    console.error("Neon syncJob error:", err);
  }
}

export async function syncTxToNeon(tx: {
  job_id: number;
  tx_signature: string;
  instruction_type: string;
  amount_lamports?: number | null;
}): Promise<void> {
  try {
    await pgPool.query(
      `INSERT INTO escrow_transactions (job_id, tx_signature, instruction_type, amount_lamports, confirmed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tx_signature) DO NOTHING`,
      [tx.job_id, tx.tx_signature, tx.instruction_type, tx.amount_lamports || null]
    );
  } catch (err) {
    console.error("Neon syncTx error:", err);
  }
}

export async function syncApplicationToNeon(app: {
  job_id: number;
  freelancer_id: number;
  message: string;
  offered_price_sol?: number | null;
  status: string;
}): Promise<void> {
  try {
    await pgPool.query(
      `INSERT INTO job_applications (job_id, freelancer_id, message, offered_price_sol, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id, freelancer_id) DO UPDATE SET status = EXCLUDED.status, message = EXCLUDED.message`,
      [app.job_id, app.freelancer_id, app.message, app.offered_price_sol || null, app.status]
    );
  } catch (err) {
    console.error("Neon syncApp error:", err);
  }
}

export async function syncDeliveryToNeon(del: {
  job_id: number;
  version: number;
  note: string;
  attachment_urls: string;
  submitted_by: number;
}): Promise<void> {
  try {
    await pgPool.query(
      `INSERT INTO deliveries (job_id, version, note, attachment_urls, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [del.job_id, del.version, del.note, del.attachment_urls, del.submitted_by]
    );
  } catch (err) {
    console.error("Neon syncDelivery error:", err);
  }
}

/** Sync all existing SQLite records to Neon PostgreSQL */
export async function syncAllFromSqliteToNeon(): Promise<{ users: number; jobs: number; txs: number }> {
  await initNeonSchema();

  // 1. Users
  const users = db.prepare("SELECT * FROM users").all() as { id: number; wallet_address: string; role: string; status: string }[];
  for (const u of users) {
    await syncUserToNeon(u);
  }

  // 2. Jobs
  const jobs = db.prepare("SELECT * FROM jobs").all() as any[];
  for (const j of jobs) {
    await syncJobToNeon(j);
  }

  // 3. Transactions
  const txs = db.prepare("SELECT * FROM escrow_transactions").all() as any[];
  for (const t of txs) {
    await syncTxToNeon(t);
  }

  // 4. Applications
  const apps = db.prepare("SELECT * FROM job_applications").all() as any[];
  for (const a of apps) {
    await syncApplicationToNeon(a);
  }

  // 5. Deliveries
  const deliveries = db.prepare("SELECT * FROM deliveries").all() as any[];
  for (const d of deliveries) {
    await syncDeliveryToNeon(d);
  }

  // 6. Credentials
  const creds = db.prepare("SELECT * FROM user_credentials").all() as any[];
  for (const c of creds) {
    await pgPool.query(
      `INSERT INTO user_credentials (user_id, username, password)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, password = EXCLUDED.password`,
      [c.user_id, c.username, c.password]
    );
  }

  console.log(`Synced to Neon: ${users.length} users, ${jobs.length} jobs, ${txs.length} transactions, ${creds.length} credentials.`);
  return { users: users.length, jobs: jobs.length, txs: txs.length };
}

/** Directly fetch jobs from Neon PostgreSQL */
export async function getJobsFromNeon(): Promise<any[]> {
  const res = await pgPool.query("SELECT * FROM jobs ORDER BY id DESC");
  return res.rows;
}

/** Directly fetch settled transactions from Neon PostgreSQL */
export async function getTransactionsFromNeon(): Promise<any[]> {
  const res = await pgPool.query(
    `SELECT t.*, j.title AS job_title, j.escrow_address, u.wallet_address AS buyer_wallet
     FROM escrow_transactions t
     JOIN jobs j ON j.id = t.job_id
     JOIN users u ON u.id = j.buyer_id
     ORDER BY t.id DESC`
  );
  return res.rows;
}

/** Directly fetch users / wallet holders from Neon PostgreSQL */
export async function getUsersFromNeon(): Promise<any[]> {
  const res = await pgPool.query("SELECT * FROM users ORDER BY id ASC");
  return res.rows;
}
