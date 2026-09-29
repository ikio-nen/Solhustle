import { db } from "./db.ts";
import { config } from "./config.ts";
import { callModel, type JsonSchema } from "./llm.ts";
import { syncCaseGraphToNeon } from "./neon.ts";
import { bad, conflict, h, notFound, parseIntOr, optionalString, requireString } from "./util.ts";

/**
 * The case layer: evidence in, and the deadline that evidence implies out.
 *
 * Two rails live behind one set of tables. The escrow rail has no statutory
 * clock of its own — its timing comes from the contract — while the UPI rail is
 * governed by the RBI's zero-liability timeline. Both are modelled the same way:
 * a clock started at some moment, and a rulebook says what that means. Adding a
 * third rail means adding a deadline rule, not another table.
 */

export type CaseRail = "escrow" | "upi";
export type CaseStatus = "open" | "ruled" | "confirmed" | "closed";
export type CaseKind = "text" | "upload" | "message" | "chain" | "document";
export type LiabilityBand = "zero" | "limited" | "bank_policy";

export type CaseRow = {
  id: number;
  rail: CaseRail;
  title: string;
  party_ref: string;
  amount: number | null;
  currency: string;
  status: CaseStatus;
  clock_started_at: string | null;
  payload_json: string;
  /** 1 when the evidence contained instruction-shaped text (see `injection.ts`). */
  suspicious: number;
  created_at: string;
  updated_at: string;
};

export type EvidenceRow = {
  id: number;
  case_id: number;
  source: string;
  kind: CaseKind;
  body: string;
  ref: string | null;
  created_at: string;
};

export type UpdateCasePatch = {
  title?: string;
  amount?: number | null;
  currency?: string;
  status?: CaseStatus;
  clock_started_at?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Set by the arbiter when it quarantines something, never by a request body:
   * the PATCH route does not read this field, so a caller cannot clear or fake
   * the flag on a case it does not like.
   */
  suspicious?: boolean;
};

// --- time ---------------------------------------------------------------------
//
// SQLite's `datetime('now')` is UTC but carries no zone marker ("2026-10-09
// 13:45:00"). Handed to `new Date()` as-is, JavaScript reads that as *local*
// time, which silently shifts every deadline by the host's offset — exactly the
// bug that would make the countdown wrong on a laptop that travelled to the
// venue. Timestamps therefore enter through `parseDbUtc`, leave through
// `toDbUtc`, and all day arithmetic happens at UTC midnight.

const MS_PER_DAY = 86_400_000;

function parseDbUtc(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // A value in the bare DB form has no zone, and it *is* UTC — say so rather
  // than letting JavaScript assume the host's offset.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDbUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Normalise any accepted timestamp to the DB's UTC text form, or null if unusable. */
export function normalizeUtc(value: string | Date): string | null {
  const d = value instanceof Date ? value : parseDbUtc(value);
  if (!d || Number.isNaN(d.getTime())) return null;
  return toDbUtc(d);
}

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isWorkingDay(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * The Nth working day after `from`'s date, as UTC midnight.
 *
 * Public bank holidays are deliberately *not* modelled. The RBI counts working
 * days, which in practice excludes them too — but a build that quietly pretended
 * to know the holiday calendar would be wrong more often than right, so the
 * limitation is surfaced in `CaseDeadline.notes` instead of guessed at.
 */
export function addWorkingDays(from: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error("working days must be a non-negative integer");
  }
  const cursor = new Date(utcMidnight(from));
  let remaining = days;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWorkingDay(cursor)) remaining--;
  }
  return cursor;
}

/** Working days elapsed over the half-open interval (from, to]. Same day is 0. */
export function workingDaysElapsed(from: Date, to: Date): number {
  const start = utcMidnight(from);
  const end = utcMidnight(to);
  if (end <= start) return 0;
  let count = 0;
  const cursor = new Date(start);
  while (cursor.getTime() < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWorkingDay(cursor)) count++;
  }
  return count;
}

/** From the RBI's 6 July 2017 circular on unauthorised electronic transactions. */
export const ZERO_LIABILITY_WORKING_DAYS = 3;
export const LIMITED_LIABILITY_WORKING_DAYS = 7;
export const RBI_CITATION =
  "RBI circular DBR.No.Leg.BC.78/09.07.005/2017-18 (6 July 2017): zero liability where the unauthorised transaction is reported within 3 working days, limited liability at 4–7 working days; beyond that the bank's own policy applies.";

/** Which liability band applies to a fraud clock started at `clockStart`, at `at`. */
export function liabilityBandFor(clockStart: Date, at: Date): LiabilityBand {
  const elapsed = workingDaysElapsed(clockStart, at);
  if (elapsed <= ZERO_LIABILITY_WORKING_DAYS) return "zero";
  if (elapsed <= LIMITED_LIABILITY_WORKING_DAYS) return "limited";
  return "bank_policy";
}

export type CaseDeadline = {
  rail: CaseRail;
  clockStartedAt: string;
  /** End of the zero-liability window: the last moment reporting still recovers. */
  dueAt: string;
  /** End of the limited-liability window, used to tell "late" from "too late". */
  limitedUntil: string;
  liabilityBand: LiabilityBand;
  /** Whole working-day boundaries still ahead of `now`. 0 means "closes today". */
  workingDaysRemaining: number;
  /** Signed: negative once `dueAt` has passed. */
  msRemaining: number;
  expired: boolean;
  label: string;
  citation: string;
  notes: string[];
};

/**
 * The deadline this case runs against, or null when nothing governs it.
 *
 * Null is a real answer, not a failure: the escrow rail has no statutory clock,
 * and inventing one would put a countdown on screen that means nothing.
 */
export function deadlineFor(
  c: Pick<CaseRow, "rail" | "clock_started_at">,
  now: Date = new Date(),
): CaseDeadline | null {
  if (c.rail !== "upi" || !c.clock_started_at) return null;
  const clock = parseDbUtc(c.clock_started_at);
  if (!clock) return null;

  const lastZeroDay = addWorkingDays(clock, ZERO_LIABILITY_WORKING_DAYS);
  const lastLimitedDay = addWorkingDays(clock, LIMITED_LIABILITY_WORKING_DAYS);
  // The window closes at the *end* of the third working day, not its start.
  const dueAt = new Date(lastZeroDay.getTime() + MS_PER_DAY - 1);
  const limitedUntil = new Date(lastLimitedDay.getTime() + MS_PER_DAY - 1);
  const msRemaining = dueAt.getTime() - now.getTime();
  const band = liabilityBandFor(clock, now);

  return {
    rail: c.rail,
    clockStartedAt: toDbUtc(clock),
    dueAt: dueAt.toISOString(),
    limitedUntil: limitedUntil.toISOString(),
    liabilityBand: band,
    workingDaysRemaining: msRemaining > 0 ? workingDaysElapsed(now, dueAt) : 0,
    msRemaining,
    expired: msRemaining <= 0,
    label:
      band === "zero"
        ? "zero-liability window open"
        : band === "limited"
          ? "zero liability missed — limited-liability window"
          : "zero and limited windows both passed",
    citation: RBI_CITATION,
    notes: [
      "Working days are Monday–Friday; public bank holidays are not modelled.",
      "Windows run in UTC and close at the end of the final working day.",
    ],
  };
}

// --- data ---------------------------------------------------------------------

export type CreateCaseInput = {
  rail: CaseRail;
  title: string;
  partyRef?: string;
  amount?: number | null;
  currency?: string;
  clockStartedAt?: string | Date | null;
  payload?: Record<string, unknown>;
  evidence?: { source?: string; kind?: CaseKind; body: string; ref?: string | null }[];
};

/**
 * Keep the Postgres copy of this case in step with SQLite.
 *
 * Fire-and-forget, like every other mirror write in the app: nothing on the
 * request path waits on Postgres, and a mirror that is unreachable must not turn a
 * ruling into a 500. The ten-minute boot sync is the backstop for whatever this
 * misses.
 *
 * Passing the id rather than the changed rows is deliberate — a ruling is
 * persisted in several steps (the decision, then its citations, then the
 * quarantine rows that get their `ruling_id` attached), and only the finished
 * article is worth copying.
 */
function mirrorCase(caseId: number): void {
  syncCaseGraphToNeon(caseId).catch(() => {});
}

export function createCase(input: CreateCaseInput): CaseRow {
  db.prepare(
    `INSERT INTO cases (rail, title, party_ref, amount, currency, clock_started_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.rail,
    input.title,
    input.partyRef ?? "",
    input.amount ?? null,
    input.currency ?? "",
    input.clockStartedAt ? normalizeUtc(input.clockStartedAt) : null,
    JSON.stringify(input.payload ?? {}),
  );

  const id = Number(
    (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint }).id,
  );
  const row = getCase(id);
  if (!row) throw new Error("case insert did not produce a row");

  for (const item of input.evidence ?? []) {
    addEvidence(id, {
      source: item.source ?? "",
      kind: item.kind ?? "text",
      body: item.body,
      ref: item.ref ?? null,
    });
  }
  // Once, after the intake evidence, rather than once per `addEvidence` call: the
  // sync reads the whole graph, so N calls would be N copies of the same rows.
  mirrorCase(id);
  return row;
}

export function getCase(id: number): CaseRow | undefined {
  return db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined;
}

export type CaseFilter = { rail?: CaseRail; status?: CaseStatus; limit?: number };

export function listCases(filter: CaseFilter = {}): CaseRow[] {
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (filter.rail) {
    where.push("rail = ?");
    params.push(filter.rail);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  params.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
  const sql = `SELECT * FROM cases ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...params) as CaseRow[];
}

/**
 * Patch a case. The column list is built from a whitelist rather than from the
 * caller's keys, so no request can steer the generated SQL.
 */
export function updateCase(id: number, patch: UpdateCasePatch): CaseRow | undefined {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.amount !== undefined) {
    sets.push("amount = ?");
    params.push(patch.amount);
  }
  if (patch.currency !== undefined) {
    sets.push("currency = ?");
    params.push(patch.currency);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.clock_started_at !== undefined) {
    sets.push("clock_started_at = ?");
    params.push(patch.clock_started_at === null ? null : normalizeUtc(patch.clock_started_at));
  }
  if (patch.payload !== undefined) {
    sets.push("payload_json = ?");
    params.push(JSON.stringify(patch.payload));
  }
  if (patch.suspicious !== undefined) {
    sets.push("suspicious = ?");
    params.push(patch.suspicious ? 1 : 0);
  }
  if (sets.length === 0) return getCase(id);

  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE cases SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  // After the write, so the copy carries whatever this update changed — and, on
  // the ruling path, the ruling and its citations that were inserted just before
  // it. That ordering is what makes this hook enough on its own for a ruling.
  mirrorCase(id);
  return getCase(id);
}

export type EvidenceInput = { source?: string; kind?: CaseKind; body: string; ref?: string | null };

export function addEvidence(caseId: number, input: EvidenceInput): EvidenceRow {
  db.prepare(
    `INSERT INTO case_evidence (case_id, source, kind, body, ref) VALUES (?, ?, ?, ?, ?)`,
  ).run(caseId, input.source ?? "", input.kind ?? "text", input.body, input.ref ?? null);
  const id = Number(
    (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint }).id,
  );
  const row = db.prepare("SELECT * FROM case_evidence WHERE id = ?").get(id) as EvidenceRow | undefined;
  if (!row) throw new Error("evidence insert did not produce a row");
  return row;
}

export function listEvidenceForCase(caseId: number): EvidenceRow[] {
  return db
    .prepare("SELECT * FROM case_evidence WHERE case_id = ? ORDER BY id ASC")
    .all(caseId) as EvidenceRow[];
}

/**
 * Delete a case and its evidence.
 *
 * A case that has been ruled cannot be deleted: its ruling is a precedent other
 * rulings cite, and removing the case would leave those citations pointing at
 * nothing. Closing it is the honest way to retire one.
 */
export function deleteCase(id: number): boolean {
  const cited = db
    .prepare("SELECT COUNT(*) AS n FROM rulings WHERE case_id = ?")
    .get(id) as { n: number | bigint };
  if (Number(cited.n) > 0) {
    throw conflict("case has rulings and cannot be deleted — close it instead");
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM case_evidence WHERE case_id = ?").run(id);
    const info = db.prepare("DELETE FROM cases WHERE id = ?").run(id);
    db.exec("COMMIT");
    return Number(info.changes) > 0;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getCaseDetail(id: number, now: Date = new Date()) {
  const row = getCase(id);
  if (!row) return undefined;
  return {
    case: row,
    evidence: listEvidenceForCase(id),
    deadline: deadlineFor(row, now),
  };
}

// --- intake structuring -------------------------------------------------------
//
// The one place the case layer touches a model before the rulebooks exist, and
// it is strictly additive: it fills fields when it can and records that it could
// not when it cannot. It never guesses. A fabricated transaction date on a real
// complaint is worse than a missing one, because the fabricated one silently
// drives the countdown.

const EXTRACT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    amount: { type: "number", minimum: 0, nullable: true },
    currency: { type: "string", maxLength: 10, nullable: true },
    occurred_at: { type: "string", maxLength: 40, nullable: true },
    txn_ref: { type: "string", maxLength: 64, nullable: true },
    counterparty: { type: "string", maxLength: 200, nullable: true },
  },
  required: ["amount", "currency", "occurred_at", "txn_ref", "counterparty"],
};

export type NarrativeExtraction = {
  amount: number | null;
  currency: string | null;
  occurred_at: string | null;
  txn_ref: string | null;
  counterparty: string | null;
};

const EXTRACT_SYSTEM = [
  "You extract structured facts from a report of a fraudulent money transfer in India.",
  "Return only JSON matching the requested shape.",
  "Use null for anything the text does not state. Never infer, estimate or complete a value.",
  "occurred_at is the date of the transaction itself, not the date it was reported, and must be ISO 8601 or null.",
].join(" ");

export type ExtractionOutcome = "llm" | "cached" | "unavailable";

export async function structureNarrative(
  narrative: string,
): Promise<{ extracted?: NarrativeExtraction; extraction: ExtractionOutcome }> {
  if (!config.llm.configured) return { extraction: "unavailable" };
  try {
    const out = await callModel<NarrativeExtraction>({
      system: EXTRACT_SYSTEM,
      prompt: narrative,
      schema: EXTRACT_SCHEMA,
    });
    return { extracted: out.result, extraction: out.cached ? "cached" : "llm" };
  } catch {
    // Intake must never fail because a model is unreachable. The caller records
    // that structuring did not happen and keeps the raw text untouched.
    return { extraction: "unavailable" };
  }
}

// --- routes --------------------------------------------------------------------

export const listCasesRoute = h(async (req, res) => {
  const rail = typeof req.query.rail === "string" ? (req.query.rail as CaseRail) : undefined;
  if (rail && rail !== "escrow" && rail !== "upi") throw bad("rail must be escrow or upi");
  const status = typeof req.query.status === "string" ? (req.query.status as CaseStatus) : undefined;
  const cases = listCases({ rail, status });
  res.json({ cases: cases.map((c) => ({ ...c, deadline: deadlineFor(c) })) });
});

export const createCaseRoute = h(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const rail = requireString(body, "rail", 20) as CaseRail;
  if (rail !== "escrow" && rail !== "upi") throw bad("rail must be escrow or upi");
  const title = requireString(body, "title", 200);
  const partyRef = optionalString(body, "party_ref", 200) ?? "";
  const currency = optionalString(body, "currency", 10) ?? "";
  const narrative = optionalString(body, "narrative", 20_000);

  let amount: number | null = null;
  if (body.amount !== undefined && body.amount !== null) {
    const n = Number(body.amount);
    if (!Number.isFinite(n) || n < 0) throw bad("amount must be a non-negative number");
    amount = n;
  }

  let clockStartedAt = optionalString(body, "clock_started_at", 40) ?? null;
  if (clockStartedAt && !normalizeUtc(clockStartedAt)) {
    throw bad("clock_started_at must be an ISO 8601 timestamp or YYYY-MM-DD");
  }

  const payload: Record<string, unknown> = {};
  if (body.payload !== undefined) {
    if (typeof body.payload !== "object" || body.payload === null || Array.isArray(body.payload)) {
      throw bad("payload must be an object");
    }
    Object.assign(payload, body.payload as Record<string, unknown>);
  }

  const evidence: EvidenceInput[] = [];
  if (body.evidence !== undefined) {
    if (!Array.isArray(body.evidence)) throw bad("evidence must be an array");
    if (body.evidence.length > 50) throw bad("evidence must hold at most 50 items");
    for (const item of body.evidence) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw bad("each evidence item must be an object");
      }
      const e = item as Record<string, unknown>;
      const itemBody = requireString(e, "body", 20_000);
      const kind = optionalString(e, "kind", 20);
      if (kind && !["text", "upload", "message", "chain", "document"].includes(kind)) {
        throw bad("evidence kind must be text, upload, message, chain or document");
      }
      evidence.push({
        source: optionalString(e, "source", 100) ?? "",
        kind: (kind as CaseKind) ?? "text",
        body: itemBody,
        ref: optionalString(e, "ref", 300) ?? null,
      });
    }
  }

  let extraction: ExtractionOutcome | "none" = "none";
  if (narrative) {
    // Whatever the model makes of it, the pasted report is itself evidence.
    evidence.push({ source: "report", kind: "text", body: narrative, ref: null });
    const structured = await structureNarrative(narrative);
    extraction = structured.extraction;
    if (structured.extracted) {
      payload.extracted = structured.extracted;
      const candidate = structured.extracted.occurred_at;
      // Adopt the extracted date only if it is a real date. An unparseable value
      // would otherwise start the clock at NaN and render a countdown that is
      // confidently wrong.
      if (!clockStartedAt && candidate) {
        const normalised = normalizeUtc(candidate);
        if (normalised) clockStartedAt = normalised;
      }
    }
  }

  const created = createCase({
    rail,
    title,
    partyRef,
    amount,
    currency,
    clockStartedAt,
    payload,
    evidence,
  });
  res.status(201).json({ case: created, deadline: deadlineFor(created), extraction });
});

export const getCaseRoute = h(async (req, res) => {
  const id = parseIntOr(req.params.id, "case id");
  const detail = getCaseDetail(id);
  if (!detail) throw notFound("case not found");
  res.json(detail);
});

export const updateCaseRoute = h(async (req, res) => {
  const id = parseIntOr(req.params.id, "case id");
  if (!getCase(id)) throw notFound("case not found");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: UpdateCasePatch = {};

  const title = optionalString(body, "title", 200);
  if (title !== undefined) patch.title = title;
  const currency = optionalString(body, "currency", 10);
  if (currency !== undefined) patch.currency = currency;
  if (body.amount !== undefined) {
    if (body.amount === null) {
      patch.amount = null;
    } else {
      const n = Number(body.amount);
      if (!Number.isFinite(n) || n < 0) throw bad("amount must be a non-negative number");
      patch.amount = n;
    }
  }
  const status = optionalString(body, "status", 20);
  if (status !== undefined) {
    if (!["open", "ruled", "confirmed", "closed"].includes(status)) {
      throw bad("status must be open, ruled, confirmed or closed");
    }
    patch.status = status as CaseStatus;
  }
  if (body.clock_started_at !== undefined) {
    if (body.clock_started_at === null) {
      patch.clock_started_at = null;
    } else {
      const next = normalizeUtc(requireString(body, "clock_started_at", 40));
      if (!next) throw bad("clock_started_at must be an ISO 8601 timestamp or YYYY-MM-DD");
      patch.clock_started_at = next;
    }
  }

  const updated = updateCase(id, patch);
  res.json({ case: updated, deadline: updated ? deadlineFor(updated) : null });
});

export const deleteCaseRoute = h(async (req, res) => {
  const id = parseIntOr(req.params.id, "case id");
  if (!getCase(id)) throw notFound("case not found");
  res.json({ deleted: deleteCase(id) });
});
