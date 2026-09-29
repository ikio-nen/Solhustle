import pg from "pg";
import { db } from "./db.ts";

/**
 * The Neon Postgres mirror.
 *
 * This app is SQLite-first: `data/app.db` is the working store, and this module is
 * a best-effort, one-way mirror of it that the demo's status view reads back.
 * Everything here therefore *degrades* rather than fails — but it is still
 * Postgres, and the rules that apply to Postgres anywhere apply here. Four of them
 * were being broken, and none of the four was a style question:
 *
 *  - Foreign keys are not indexed automatically. Twenty FK columns in this schema
 *    had no index, so `where job_id = ?` was a sequential scan, and so was the
 *    join the status view actually runs. See `initNeonSchema`.
 *  - Writes were one INSERT per row. A single statement per table is the
 *    difference between a sync that finishes and one that holds the pool slot for
 *    hundreds of round trips. See `batchUpsert`.
 *  - No statement was bounded, so a query that went wrong held its connection
 *    indefinitely. See `STATEMENT_TIMEOUT_MS` and the pool's connect hook.
 *  - The module carried a hardcoded owner credential for a live database, and
 *    disabled TLS certificate verification. Both are gone.
 *
 * It also mirrored the marketplace and nothing else. Contracts and settlements
 * had a copy outside `data/app.db`; Nyaya's own record — cases, the evidence
 * behind them, the rulings, and the citations between those rulings — did not.
 * That made the case-law memory, which is the product's differentiator, the one
 * part of it that lived in a single file on one machine. The adjudication
 * tables are mirrored here for the same reason the escrow ones are.
 */

/**
 * The connection string, or empty when no mirror is configured.
 *
 * There used to be a hardcoded fallback here pointing at a real Neon database
 * with its owner password in the source. A committed database credential is a
 * credential that has to be rotated by everyone who ever cloned the repo, and it
 * silently made an unconfigured deployment write to somebody else's database. The
 * mirror is now simply off unless `DATABASE_URL` says where to mirror to.
 */
const connectionString = (process.env.DATABASE_URL || "").trim();

/** True when a Postgres mirror is configured at all. Every entry point checks it. */
export const neonConfigured = connectionString !== "";

/** Long enough for the mirror's upserts, short enough that nothing hangs forever. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** A lock wait is never worth the statement timeout; give up and let the next sync retry. */
const LOCK_TIMEOUT_MS = 10_000;
/** Rows per batched statement, before the parameter ceiling is applied. */
const BATCH_SIZE = 500;
/** Postgres' hard limit on parameters in one statement. */
const MAX_PARAMS = 65_535;

/**
 * SQLite's `datetime('now')` is UTC but carries no zone: '2026-09-29 04:11:07'.
 * Handed to Postgres like that, a TIMESTAMPTZ column reads it in whatever
 * timezone the session happens to be set to, so every timestamp the mirror
 * copied would land shifted by the endpoint's offset — and nothing would fail.
 * Stamping the `Z` makes the value mean one thing instead of asking the server
 * to guess which.
 *
 * Exported because it is the one conversion in this module that is silent when
 * it is wrong, so a test should be the thing that pins it.
 */
export function toUtcIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = String(value).trim();
  if (!text) return null;
  const sqlite = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(text);
  if (sqlite) return `${sqlite[1]}T${sqlite[2]}${sqlite[3] ?? ""}Z`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * A JSONB column validates on insert, and one unparseable row takes its whole
 * batch down with it — up to `BATCH_SIZE` unrelated rows, because a failed batch
 * is reported rather than retried row by row. The case payload is written with
 * `JSON.stringify`, so a malformed one should not exist; degrading it to an empty
 * object keeps a corrupt payload from becoming a corrupt sync.
 *
 * Exported for the same reason as `toUtcIso`: it is a guard, and a guard that
 * only runs when the data is already wrong is a guard nobody has tested.
 */
export function jsonOrEmpty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "{}";
  try {
    JSON.parse(value);
    return value;
  } catch {
    return "{}";
  }
}

export const pgPool = new pg.Pool({
  connectionString: connectionString || undefined,
  // Neon terminates TLS with a publicly trusted certificate, so verification is
  // possible and therefore mandatory. The previous `rejectUnauthorized: false`
  // accepted any certificate at all — encrypted against a passive listener, wide
  // open to anyone who can answer a DNS lookup.
  ssl: neonConfigured ? { rejectUnauthorized: true } : undefined,
  // (CPU cores * 2) + spindles is the usual starting point. Neon's pooler sits in
  // front of this, so ten per process is generous rather than tight.
  max: 10,
  idleTimeoutMillis: 30_000,
  // Without this the pool waits for the OS TCP timeout. On a boot-time sync that
  // means the server appears to hang rather than starting without the mirror.
  connectionTimeoutMillis: 10_000,
});

/**
 * Bound every statement, on every connection the pool opens.
 *
 * Deliberately not the `options` startup parameter, and not the `statement_timeout`
 * pool option: Neon's pooler rejects `options` outright ("unsupported startup
 * parameter in options: statement_timeout"), and node-postgres' own option is sent
 * the same way, so it arrives as a silent no-op — measured as `0` against this
 * endpoint. A `SET` issued here runs before the connection is handed out, so the
 * caller's first query already sees the limit.
 */
pgPool.on("connect", (client) => {
  // Both in one statement: a second `client.query()` while the first is still
  // executing is deprecated in pg 8 and removed in pg 9, and the simple query
  // protocol carries multi-statement text in a single round trip anyway.
  void client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}; SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
});

type SqlValue = string | number | null;

/**
 * Run one multi-row `INSERT ... ON CONFLICT` per batch.
 *
 * The mirror used to issue one statement per row, so syncing users, jobs and
 * transactions cost one round trip each: 178 for the current database, every boot
 * and every ten minutes after it. Batching makes that three, which matters more
 * over the public internet to another region than the row count suggests.
 *
 * The batch is capped by *parameters*, not rows: Postgres refuses a statement
 * carrying more than 65535 of them, and a row's width decides how many it costs.
 */
async function batchUpsert(
  label: string,
  prefix: string,
  tuples: SqlValue[][],
  suffix: string,
): Promise<number> {
  if (!neonConfigured || tuples.length === 0) return 0;

  const width = tuples[0]!.length;
  const perStatement = Math.max(1, Math.min(BATCH_SIZE, Math.floor(MAX_PARAMS / width)));
  let written = 0;

  for (let offset = 0; offset < tuples.length; offset += perStatement) {
    const chunk = tuples.slice(offset, offset + perStatement);
    const params: SqlValue[] = [];
    const groups = chunk.map(
      (tuple) =>
        `(${tuple
          .map((value) => {
            params.push(value);
            return `$${params.length}`;
          })
          .join(", ")})`,
    );
    try {
      await pgPool.query(`${prefix}${groups.join(", ")}${suffix}`, params);
      written += chunk.length;
    } catch (err) {
      // Best-effort by design: a mirror that cannot keep up must not take the app
      // down with it. The failure is logged with the batch that caused it.
      console.error(`Neon batch ${label} failed:`, err);
    }
  }
  return written;
}

export async function initNeonSchema(): Promise<void> {
  if (!neonConfigured) return;
  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        wallet_address TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('client','freelancer','support','dev')),
        roles TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Additive migration for databases created before dual-role landed.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NOT NULL DEFAULT '';
      UPDATE users SET roles = role WHERE roles = '' OR roles IS NULL;

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

    /**
     * Nyaya's tables.
     *
     * Same columns as the SQLite rows they come from, with four deliberate
     * differences.
     *
     * Timestamps are TIMESTAMPTZ and are bound from the row instead of being left
     * to `DEFAULT NOW()`. When a ruling was written is part of the case-law record
     * — it orders the precedents and it is what a reviewer reads — so stamping it
     * with the moment the mirror last ran would quietly rewrite history on every
     * sync.
     *
     * `payload_json` is JSONB, so the rail's own facts (the UPI transaction date,
     * the escrow round) are queryable rather than being an opaque string.
     *
     * The primary keys are plain INTEGER, not SERIAL. Every id here arrives from
     * SQLite, so a sequence would never be drawn from and would only exist to drift
     * away from the ids actually in the table.
     *
     * `ruling_fts` is deliberately *not* mirrored. It is an FTS5 index derived from
     * `rulings`, it has no Postgres equivalent, and it is rebuildable from the rows
     * that are mirrored — copying it would add a second thing to keep in step with
     * the first. The mirror's job is the record, not the index over it.
     */
    await client.query(`
      CREATE TABLE IF NOT EXISTS cases (
        id INTEGER PRIMARY KEY,
        rail TEXT NOT NULL CHECK (rail IN ('escrow','upi')),
        title TEXT NOT NULL,
        party_ref TEXT NOT NULL DEFAULT '',
        amount DOUBLE PRECISION,
        currency TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ruled','confirmed','closed')),
        clock_started_at TIMESTAMPTZ,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        suspicious INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS case_evidence (
        id INTEGER PRIMARY KEY,
        case_id INTEGER NOT NULL REFERENCES cases(id),
        source TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','upload','message','chain','document')),
        body TEXT NOT NULL DEFAULT '',
        ref TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rulings (
        id INTEGER PRIMARY KEY,
        case_id INTEGER NOT NULL REFERENCES cases(id),
        rulebook TEXT NOT NULL,
        decision TEXT NOT NULL,
        confidence DOUBLE PRECISION,
        reasoning TEXT NOT NULL DEFAULT '',
        deadline_at TIMESTAMPTZ,
        liability_band TEXT,
        model TEXT,
        cached INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ruling_citations (
        ruling_id INTEGER NOT NULL REFERENCES rulings(id),
        cited_ruling_id INTEGER NOT NULL REFERENCES rulings(id),
        weight DOUBLE PRECISION NOT NULL DEFAULT 1,
        PRIMARY KEY (ruling_id, cited_ruling_id)
      );

      CREATE TABLE IF NOT EXISTS evidence_quarantine (
        id INTEGER PRIMARY KEY,
        case_id INTEGER NOT NULL REFERENCES cases(id),
        ruling_id INTEGER REFERENCES rulings(id),
        evidence_ref TEXT NOT NULL DEFAULT '',
        rule_id TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL
      );
    `);

    /**
     * Index every foreign key.
     *
     * Postgres does not index a referencing column for you, so all of these were
     * being found by sequence scan: a `where job_id = ?` lookup, and the join in
     * the status view, which the planner answered by scanning all of
     * `escrow_transactions` and sorting it. On today's table sizes that is
     * milliseconds — the point is that it grows with the table while an index
     * lookup does not.
     *
     * Idempotent and additive, like the rest of this function: it runs on every
     * boot and changes nothing when the indexes are already there. Plain
     * `CREATE INDEX` rather than `CONCURRENTLY`, because boot DDL arrives as one
     * implicit transaction and `CONCURRENTLY` cannot run inside one; at these
     * sizes the brief lock is not worth the complexity.
     */
    await client.query(`
      CREATE INDEX IF NOT EXISTS deliveries_job_id_idx ON deliveries (job_id);
      CREATE INDEX IF NOT EXISTS deliveries_submitted_by_idx ON deliveries (submitted_by);
      CREATE INDEX IF NOT EXISTS disputes_job_id_idx ON disputes (job_id);
      CREATE INDEX IF NOT EXISTS disputes_raised_by_idx ON disputes (raised_by);
      CREATE INDEX IF NOT EXISTS disputes_ruled_by_idx ON disputes (ruled_by);
      CREATE INDEX IF NOT EXISTS escrow_transactions_job_id_idx ON escrow_transactions (job_id);
      CREATE INDEX IF NOT EXISTS jobs_buyer_id_idx ON jobs (buyer_id);
      CREATE INDEX IF NOT EXISTS jobs_freelancer_id_idx ON jobs (freelancer_id);
      CREATE INDEX IF NOT EXISTS messages_job_id_idx ON messages (job_id);
      CREATE INDEX IF NOT EXISTS messages_sender_id_idx ON messages (sender_id);
      CREATE INDEX IF NOT EXISTS negotiations_job_id_idx ON negotiations (job_id);
      CREATE INDEX IF NOT EXISTS negotiations_offer_by_idx ON negotiations (offer_by);
      CREATE INDEX IF NOT EXISTS portfolio_items_domain_id_idx ON portfolio_items (domain_id);
      CREATE INDEX IF NOT EXISTS portfolio_items_freelancer_id_idx ON portfolio_items (freelancer_id);
      CREATE INDEX IF NOT EXISTS ratings_client_id_idx ON ratings (client_id);
      CREATE INDEX IF NOT EXISTS ratings_freelancer_id_idx ON ratings (freelancer_id);
      CREATE INDEX IF NOT EXISTS user_notifications_job_id_idx ON user_notifications (job_id);
      CREATE INDEX IF NOT EXISTS user_notifications_user_id_idx ON user_notifications (user_id);

      -- These two are the gaps the usual "missing FK index" query cannot see: it
      -- treats a column as indexed if *any* index mentions it, even when it is only
      -- the trailing column of a composite. A lookup by them is still a scan.
      CREATE INDEX IF NOT EXISTS freelancer_domains_subdomain_id_idx ON freelancer_domains (subdomain_id);
      CREATE INDEX IF NOT EXISTS job_applications_freelancer_id_idx ON job_applications (freelancer_id);

      CREATE INDEX IF NOT EXISTS cases_rail_status_idx ON cases (rail, status);
      CREATE INDEX IF NOT EXISTS case_evidence_case_id_idx ON case_evidence (case_id);
      CREATE INDEX IF NOT EXISTS rulings_case_id_idx ON rulings (case_id);
      CREATE INDEX IF NOT EXISTS rulings_rulebook_idx ON rulings (rulebook);
      CREATE INDEX IF NOT EXISTS evidence_quarantine_case_id_idx ON evidence_quarantine (case_id);
      CREATE INDEX IF NOT EXISTS evidence_quarantine_ruling_id_idx ON evidence_quarantine (ruling_id);

      -- The trailing-column trap, and the one place it really bites: as in the
      -- composite columns called out above, ruling_citations is keyed
      -- (ruling_id, cited_ruling_id), so the primary key already covers lookups by
      -- ruling_id — while "which rulings cite this one?", which is the precedent
      -- graph read, was still a sequential scan.
      CREATE INDEX IF NOT EXISTS ruling_citations_cited_ruling_id_idx ON ruling_citations (cited_ruling_id);
    `);

    console.log("Neon Postgres tables and indexes verified.");
  } finally {
    client.release();
  }
}

// --- column lists and conflict clauses -----------------------------------------
//
// Declared once and used by both the single-row and the batched path, so the two
// cannot drift into disagreeing about what an upsert means.

const USER_PREFIX = "INSERT INTO users (wallet_address, role, roles, status) VALUES ";
const USER_CONFLICT =
  " ON CONFLICT (wallet_address) DO UPDATE SET role = EXCLUDED.role, roles = EXCLUDED.roles, status = EXCLUDED.status";

// `updated_at`, `confirmed_at` and `submitted_at` are deliberately absent from
// these column lists. All three are NOT NULL DEFAULT NOW(), so omitting them lets
// the default do the work on insert — which is what makes one statement able to
// serve every row in a batch. Naming them and binding a placeholder would insert
// NULL and violate the constraint.
const JOB_PREFIX =
  "INSERT INTO jobs (id, buyer_id, freelancer_id, title, requirements, usd_budget, sol_amount, sol_lamports, price_rate, price_source, price_fetched_at, status, escrow_address, round) VALUES ";
const JOB_CONFLICT = ` ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      freelancer_id = EXCLUDED.freelancer_id,
      escrow_address = EXCLUDED.escrow_address,
      round = EXCLUDED.round,
      updated_at = NOW()`;

const TX_PREFIX =
  "INSERT INTO escrow_transactions (job_id, tx_signature, instruction_type, amount_lamports) VALUES ";
const TX_CONFLICT = " ON CONFLICT (tx_signature) DO NOTHING";

// --- Nyaya --------------------------------------------------------------------
//
// `created_at` appears in these column lists, unlike `updated_at`/`confirmed_at`
// above. Those are defaulted so that one statement can serve a whole batch; these
// are part of the record, so they are bound from the row.

const CASE_PREFIX =
  "INSERT INTO cases (id, rail, title, party_ref, amount, currency, status, clock_started_at, payload_json, suspicious, created_at, updated_at) VALUES ";
const CASE_CONFLICT = ` ON CONFLICT (id) DO UPDATE SET
      rail = EXCLUDED.rail,
      title = EXCLUDED.title,
      party_ref = EXCLUDED.party_ref,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      status = EXCLUDED.status,
      clock_started_at = EXCLUDED.clock_started_at,
      payload_json = EXCLUDED.payload_json,
      suspicious = EXCLUDED.suspicious,
      updated_at = EXCLUDED.updated_at`;

const EVIDENCE_PREFIX =
  "INSERT INTO case_evidence (id, case_id, source, kind, body, ref, created_at) VALUES ";
const EVIDENCE_CONFLICT = ` ON CONFLICT (id) DO UPDATE SET
      source = EXCLUDED.source,
      kind = EXCLUDED.kind,
      body = EXCLUDED.body,
      ref = EXCLUDED.ref`;

// A ruling is a precedent the moment it is written, so this upsert is the one
// that does nothing on conflict: rewriting a mirrored ruling would change, after
// the fact, what a later case was entitled to cite.
const RULING_PREFIX =
  "INSERT INTO rulings (id, case_id, rulebook, decision, confidence, reasoning, deadline_at, liability_band, model, cached, created_at) VALUES ";
const RULING_CONFLICT = " ON CONFLICT (id) DO NOTHING";

const CITATION_PREFIX =
  "INSERT INTO ruling_citations (ruling_id, cited_ruling_id, weight) VALUES ";
const CITATION_CONFLICT = " ON CONFLICT (ruling_id, cited_ruling_id) DO NOTHING";

// `ruling_id` is the one column that changes after its row exists: the arbiter
// records an attempted injection before it asks the model, then attaches the
// ruling to the record afterwards. So this upsert does have something to update.
const QUARANTINE_PREFIX =
  "INSERT INTO evidence_quarantine (id, case_id, ruling_id, evidence_ref, rule_id, snippet, created_at) VALUES ";
const QUARANTINE_CONFLICT = ` ON CONFLICT (id) DO UPDATE SET
      ruling_id = EXCLUDED.ruling_id,
      snippet = EXCLUDED.snippet`;

export type NeonUser = {
  id?: number;
  wallet_address: string;
  role: string;
  roles?: string;
  status?: string;
};

export type NeonJob = {
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
};

export type NeonTx = {
  job_id: number;
  tx_signature: string;
  instruction_type: string;
  amount_lamports?: number | null;
};

export type NeonCase = {
  id: number;
  rail: string;
  title: string;
  party_ref?: string | null;
  amount?: number | null;
  currency?: string | null;
  status: string;
  clock_started_at?: string | null;
  payload_json?: string | null;
  suspicious?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type NeonEvidence = {
  id: number;
  case_id: number;
  source?: string | null;
  kind?: string | null;
  body?: string | null;
  ref?: string | null;
  created_at?: string | null;
};

export type NeonRuling = {
  id: number;
  case_id: number;
  rulebook: string;
  decision: string;
  confidence?: number | null;
  reasoning?: string | null;
  deadline_at?: string | null;
  liability_band?: string | null;
  model?: string | null;
  cached?: number | null;
  created_at?: string | null;
};

export type NeonCitation = {
  ruling_id: number;
  cited_ruling_id: number;
  weight?: number | null;
};

export type NeonQuarantine = {
  id: number;
  case_id: number;
  ruling_id?: number | null;
  evidence_ref?: string | null;
  rule_id: string;
  snippet?: string | null;
  created_at?: string | null;
};

// These tuples are positional against the prefixes above, so their widths must
// match the column lists exactly.
const userTuple = (u: NeonUser): SqlValue[] => [
  u.wallet_address,
  u.role,
  u.roles || u.role,
  u.status || "active",
];

const jobTuple = (j: NeonJob): SqlValue[] => [
  j.id,
  j.buyer_id,
  j.freelancer_id || null,
  j.title,
  j.requirements,
  j.usd_budget,
  j.sol_amount || null,
  j.sol_lamports || null,
  j.price_rate || null,
  j.price_source || null,
  j.price_fetched_at || null,
  j.status,
  j.escrow_address || null,
  j.round || 1,
];

const txTuple = (t: NeonTx): SqlValue[] => [
  t.job_id,
  t.tx_signature,
  t.instruction_type,
  t.amount_lamports || null,
];

// The `?? now` fallbacks on the NOT NULL timestamps are unreachable for rows this
// app wrote — the SQLite columns are NOT NULL with a default — and cover a row
// inserted by something else, where a wrong timestamp would be worse than a
// rejected batch. Both failure modes need the same fix, so they get the same one.
const caseTuple = (c: NeonCase): SqlValue[] => [
  c.id,
  c.rail,
  c.title,
  c.party_ref || "",
  c.amount ?? null,
  c.currency || "",
  c.status,
  toUtcIso(c.clock_started_at),
  jsonOrEmpty(c.payload_json),
  c.suspicious ? 1 : 0,
  toUtcIso(c.created_at) ?? new Date().toISOString(),
  toUtcIso(c.updated_at) ?? new Date().toISOString(),
];

const evidenceTuple = (e: NeonEvidence): SqlValue[] => [
  e.id,
  e.case_id,
  e.source || "",
  e.kind || "text",
  e.body || "",
  e.ref || null,
  toUtcIso(e.created_at) ?? new Date().toISOString(),
];

const rulingTuple = (r: NeonRuling): SqlValue[] => [
  r.id,
  r.case_id,
  r.rulebook,
  r.decision,
  r.confidence ?? null,
  r.reasoning || "",
  toUtcIso(r.deadline_at),
  r.liability_band || null,
  r.model || null,
  r.cached ? 1 : 0,
  toUtcIso(r.created_at) ?? new Date().toISOString(),
];

const citationTuple = (c: NeonCitation): SqlValue[] => [
  c.ruling_id,
  c.cited_ruling_id,
  c.weight ?? 1,
];

const quarantineTuple = (q: NeonQuarantine): SqlValue[] => [
  q.id,
  q.case_id,
  q.ruling_id ?? null,
  q.evidence_ref || "",
  q.rule_id,
  q.snippet || "",
  toUtcIso(q.created_at) ?? new Date().toISOString(),
];

// --- single-row entry points ----------------------------------------------------
//
// Called from the request path when one row changes, so the mirror keeps up
// between boot syncs. Each is a batch of one.

export async function syncUserToNeon(user: NeonUser): Promise<void> {
  await batchUpsert("user", USER_PREFIX, [userTuple(user)], USER_CONFLICT);
}

export async function syncJobToNeon(job: NeonJob): Promise<void> {
  await batchUpsert("job", JOB_PREFIX, [jobTuple(job)], JOB_CONFLICT);
}

export async function syncTxToNeon(tx: NeonTx): Promise<void> {
  await batchUpsert("tx", TX_PREFIX, [txTuple(tx)], TX_CONFLICT);
}

export async function syncApplicationToNeon(app: {
  job_id: number;
  freelancer_id: number;
  message: string;
  offered_price_sol?: number | null;
  status: string;
}): Promise<void> {
  await batchUpsert(
    "application",
    "INSERT INTO job_applications (job_id, freelancer_id, message, offered_price_sol, status) VALUES ",
    [[app.job_id, app.freelancer_id, app.message, app.offered_price_sol || null, app.status]],
    " ON CONFLICT (job_id, freelancer_id) DO UPDATE SET status = EXCLUDED.status, message = EXCLUDED.message",
  );
}

export async function syncDeliveryToNeon(del: {
  job_id: number;
  version: number;
  note: string;
  attachment_urls: string;
  submitted_by: number;
}): Promise<void> {
  // No natural key to conflict on: deliveries are append-only revisions, and the
  // unique pair is what makes a replayed delivery idempotent rather than doubled.
  await batchUpsert(
    "delivery",
    "INSERT INTO deliveries (job_id, version, note, attachment_urls, submitted_by) VALUES ",
    [[del.job_id, del.version, del.note, del.attachment_urls, del.submitted_by]],
    " ON CONFLICT DO NOTHING",
  );
}

/**
 * Mirror one case and everything hanging off it.
 *
 * Called from the request path after a case changes, so the copy keeps up between
 * the ten-minute boot syncs. It re-reads the graph rather than accepting the
 * changed row as an argument, because a ruling is written in several steps — the
 * decision, then its citations, then the quarantine rows that get their
 * `ruling_id` attached — and asking SQLite for the finished article is the only
 * way to be sure the mirror gets all of it.
 *
 * The order is the foreign keys: the case, then the rows that point at it, then
 * the edges that point at those. A cited ruling belongs to an earlier case, which
 * was mirrored when it was ruled, so the far side of every citation exists by the
 * time this runs.
 */
export async function syncCaseGraphToNeon(caseId: number): Promise<number> {
  if (!neonConfigured) return 0;
  try {
    const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId) as NeonCase | undefined;
    if (!row) return 0;

    let written = await batchUpsert("case", CASE_PREFIX, [caseTuple(row)], CASE_CONFLICT);

    const evidence = db
      .prepare("SELECT * FROM case_evidence WHERE case_id = ? ORDER BY id")
      .all(caseId) as NeonEvidence[];
    written += await batchUpsert(
      "case evidence",
      EVIDENCE_PREFIX,
      evidence.map(evidenceTuple),
      EVIDENCE_CONFLICT,
    );

    const rulings = db
      .prepare("SELECT * FROM rulings WHERE case_id = ? ORDER BY id")
      .all(caseId) as NeonRuling[];
    written += await batchUpsert("rulings", RULING_PREFIX, rulings.map(rulingTuple), RULING_CONFLICT);

    const citations = db
      .prepare(
        `SELECT rc.ruling_id, rc.cited_ruling_id, rc.weight
           FROM ruling_citations rc
           JOIN rulings r ON r.id = rc.ruling_id
          WHERE r.case_id = ?
          ORDER BY rc.ruling_id, rc.cited_ruling_id`,
      )
      .all(caseId) as NeonCitation[];
    written += await batchUpsert(
      "citations",
      CITATION_PREFIX,
      citations.map(citationTuple),
      CITATION_CONFLICT,
    );

    const quarantine = db
      .prepare("SELECT * FROM evidence_quarantine WHERE case_id = ? ORDER BY id")
      .all(caseId) as NeonQuarantine[];
    written += await batchUpsert(
      "quarantine",
      QUARANTINE_PREFIX,
      quarantine.map(quarantineTuple),
      QUARANTINE_CONFLICT,
    );

    return written;
  } catch (err) {
    // Best-effort like every other write here: a mirror that cannot keep up must
    // not turn a ruling into a 500 for the person who is waiting on it.
    // `batchUpsert` already logs the batches it loses.
    console.error(`Neon case graph sync failed for case ${caseId}:`, err);
    return 0;
  }
}

// --- boot syncs -----------------------------------------------------------------

/** Fan out every SQLite user to Neon in one batched statement. */
export async function syncAllUsersToNeon(): Promise<number> {
  if (!neonConfigured) return 0;
  try {
    const users = db
      .prepare("SELECT id, wallet_address, role, roles, status FROM users")
      .all() as NeonUser[];
    if (!users.length) return 0;
    const written = await batchUpsert("users", USER_PREFIX, users.map(userTuple), USER_CONFLICT);
    console.log("Neon: synced", written, "users");
    return written;
  } catch (err) {
    console.error("Neon: batch user sync failed:", err);
    return 0;
  }
}

export type NeonSyncCounts = {
  users: number;
  jobs: number;
  txs: number;
  cases: number;
  evidence: number;
  rulings: number;
  citations: number;
  quarantined: number;
};

/**
 * Full boot sync — one statement per table, not one per row.
 *
 * Every count returned is a count of rows *written*. It used to return the SQLite
 * row count for users and the written count for everything else, which read as a
 * successful sync in the log even when every batch had been rejected.
 */
export async function syncAllFromSqliteToNeonFull(): Promise<NeonSyncCounts> {
  if (!neonConfigured) {
    return { users: 0, jobs: 0, txs: 0, cases: 0, evidence: 0, rulings: 0, citations: 0, quarantined: 0 };
  }

  try {
    await initNeonSchema();
  } catch (err) {
    // The schema is best-effort like everything else here, but a failure now means
    // every write below will fail too, so it is worth saying out loud.
    console.error("Neon schema init failed (sync continues):", err);
  }

  const userCount = await syncAllUsersToNeon();

  const jobs = db.prepare("SELECT * FROM jobs").all() as NeonJob[];
  const jobCount = await batchUpsert("jobs", JOB_PREFIX, jobs.map(jobTuple), JOB_CONFLICT);

  const txs = db.prepare("SELECT * FROM escrow_transactions").all() as NeonTx[];
  const txCount = await batchUpsert("txs", TX_PREFIX, txs.map(txTuple), TX_CONFLICT);

  // The adjudication layer, in foreign-key order: cases, then the rows that point
  // at them, then the citations that point at the rulings. Running the whole table
  // in this order is also what guarantees a cited ruling is present before the
  // citation that references it.
  const cases = db.prepare("SELECT * FROM cases").all() as NeonCase[];
  const caseCount = await batchUpsert("cases", CASE_PREFIX, cases.map(caseTuple), CASE_CONFLICT);

  const evidence = db.prepare("SELECT * FROM case_evidence ORDER BY id").all() as NeonEvidence[];
  const evidenceCount = await batchUpsert(
    "case evidence",
    EVIDENCE_PREFIX,
    evidence.map(evidenceTuple),
    EVIDENCE_CONFLICT,
  );

  const rulings = db.prepare("SELECT * FROM rulings ORDER BY id").all() as NeonRuling[];
  const rulingCount = await batchUpsert("rulings", RULING_PREFIX, rulings.map(rulingTuple), RULING_CONFLICT);

  const citations = db
    .prepare("SELECT * FROM ruling_citations ORDER BY ruling_id, cited_ruling_id")
    .all() as NeonCitation[];
  const citationCount = await batchUpsert(
    "citations",
    CITATION_PREFIX,
    citations.map(citationTuple),
    CITATION_CONFLICT,
  );

  const quarantine = db.prepare("SELECT * FROM evidence_quarantine ORDER BY id").all() as NeonQuarantine[];
  const quarantinedCount = await batchUpsert(
    "quarantine",
    QUARANTINE_PREFIX,
    quarantine.map(quarantineTuple),
    QUARANTINE_CONFLICT,
  );

  console.log(
    `Neon full sync: ${userCount} users, ${jobCount} jobs, ${txCount} txs, ` +
      `${caseCount} cases, ${evidenceCount} evidence, ${rulingCount} rulings, ` +
      `${citationCount} citations, ${quarantinedCount} quarantined`,
  );

  return {
    users: userCount,
    jobs: jobCount,
    txs: txCount,
    cases: caseCount,
    evidence: evidenceCount,
    rulings: rulingCount,
    citations: citationCount,
    quarantined: quarantinedCount,
  };
}

/** Thin boot-only entrypoint used to keep the server listening quickly. */
export async function syncAllFromSqliteToNeonBootOnly(): Promise<void> {
  if (!neonConfigured) return;
  try {
    await syncAllUsersToNeon();
  } catch (err) {
    console.error("Neon: boot user sync failed:", err);
  }
}

// --- reads ----------------------------------------------------------------------
//
// With no mirror configured these answer empty rather than throwing, so the
// status view can report "not connected" instead of a 500.

/** Directly fetch jobs from Neon PostgreSQL */
export async function getJobsFromNeon(): Promise<any[]> {
  if (!neonConfigured) return [];
  const res = await pgPool.query("SELECT * FROM jobs ORDER BY id DESC");
  return res.rows;
}

/** Directly fetch settled transactions from Neon PostgreSQL */
export async function getTransactionsFromNeon(): Promise<any[]> {
  if (!neonConfigured) return [];
  const res = await pgPool.query(
    `SELECT t.*, j.title AS job_title, j.escrow_address, u.wallet_address AS buyer_wallet
     FROM escrow_transactions t
     JOIN jobs j ON j.id = t.job_id
     JOIN users u ON u.id = j.buyer_id
     ORDER BY t.id DESC`,
  );
  return res.rows;
}

/** Directly fetch users / wallet holders from Neon PostgreSQL */
export async function getUsersFromNeon(): Promise<any[]> {
  if (!neonConfigured) return [];
  const res = await pgPool.query("SELECT * FROM users ORDER BY id ASC");
  return res.rows;
}

/**
 * The case-law view: every mirrored case with a count of what it produced.
 *
 * Counted with scalar subqueries rather than a GROUP BY over two LEFT JOINs.
 * Joining `rulings` and their `ruling_citations` fans out — one ruling with three
 * citations becomes three rows — so `COUNT(r.id)` would report three rulings for
 * a case that has one. The number a reviewer reads off this view is a claim about
 * the record, so it has to be the record's number. Each subquery is a lookup on
 * one of the foreign key indexes declared in `initNeonSchema`.
 */
export async function getCaseLawFromNeon(): Promise<any[]> {
  if (!neonConfigured) return [];
  const res = await pgPool.query(
    `SELECT c.id, c.rail, c.title, c.party_ref, c.status, c.amount, c.currency,
            c.suspicious, c.created_at,
            (SELECT COUNT(*) FROM rulings r WHERE r.case_id = c.id) AS rulings,
            (SELECT COUNT(*) FROM ruling_citations rc
               JOIN rulings r ON r.id = rc.ruling_id
              WHERE r.case_id = c.id) AS citations
       FROM cases c
      ORDER BY c.id DESC`,
  );
  return res.rows;
}
