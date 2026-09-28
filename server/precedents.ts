import { db } from "./db.ts";
import type { EvidenceItem, PriorRuling } from "./rulebooks/types.ts";

/**
 * Precedent storage and retrieval.
 *
 * A ruling is indexed the moment it is written, and the next case on the same
 * rail is offered the closest ones. The FTS table holds a *pointer*: every field
 * handed back to the arbiter is read from `rulings` at retrieval time, so a
 * citation's provenance is always a real prior ruling with a real case id, never
 * a copy that drifted.
 *
 * Bodies are indexed from the *sanitised* bundle. A quarantined item is indexed
 * as its placeholder, which means an injection cannot ride into a future prompt
 * through the precedent graph — the one path where a poisoning could otherwise
 * be laundered into every later decision.
 */

export const PRECEDENT_LIMIT = 3;

/** Words too common to discriminate between disputes. */
const STOPWORDS = new Set([
  "the", "and", "for", "was", "were", "are", "has", "have", "had", "not", "but", "with", "this",
  "that", "these", "those", "from", "they", "them", "then", "than", "there", "their", "been",
  "into", "over", "under", "after", "before", "when", "what", "which", "while", "who", "whom",
  "you", "your", "yours", "she", "her", "him", "his", "its", "our", "ours", "all", "any", "can",
  "could", "would", "should", "shall", "will", "may", "might", "must", "does", "did", "doing",
  "done", "get", "got", "also", "just", "only", "very", "more", "most", "some", "such", "same",
  "each", "other", "another", "about", "because", "however", "please", "yes", "per", "via",
  // Domain words that appear in nearly every case on a rail add no signal.
  "job", "case", "contract", "escrow", "buyer", "seller", "freelancer", "client", "delivery",
  "deliverable", "payment", "pay", "sol", "lamports", "dispute", "work", "project",
]);

/**
 * The search terms for a block of text.
 *
 * Tokens are restricted to `[a-z0-9]`, which makes them safe to quote verbatim
 * into an FTS5 query: an arbitrary string fed to MATCH can raise a syntax error
 * ("unterminated string"), and evidence is arbitrary string.
 */
export function tokensOf(text: string, limit = 12): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]{3,24}/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  // Longest first: in a corpus this small, a longer shared word ("captions",
  // "velocity") discriminates far better than a short one ("logo", "kit").
  return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, limit);
}

/** An FTS5 query for these terms, or null when nothing usable survives. */
export function precedentQuery(text: string, limit = 12): string | null {
  const tokens = tokensOf(text, limit);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/** The text a case is matched against: its title and its (sanitised) evidence. */
export function precedentTextOf(title: string, items: EvidenceItem[]): string {
  return [title, ...items.map((i) => i.body)].join("\n");
}

export type IndexRulingArgs = {
  rulingId: number;
  caseId: number;
  rulebook: string;
  decision: string;
  liabilityBand: string;
  reasoning: string;
  /** The sanitised bodies, in the order the model saw them. */
  evidence: string[];
};

/** Index (or re-index) a ruling. Idempotent: a re-index replaces the row. */
export function indexRuling(args: IndexRulingArgs): void {
  const body = [args.reasoning, ...args.evidence].join("\n");
  db.prepare("DELETE FROM ruling_fts WHERE ruling_id = ?").run(args.rulingId);
  db.prepare(
    `INSERT INTO ruling_fts (ruling_id, case_id, rulebook, decision, liability_band, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(args.rulingId, args.caseId, args.rulebook, args.decision, args.liabilityBand, body);
}

export type RetrieveArgs = {
  rulebook: string;
  text: string;
  /** The case being ruled: a case never cites itself, which also keeps a re-rule deterministic. */
  excludeCaseId: number;
  limit?: number;
};

/**
 * The closest prior rulings on the same rail, best match first.
 *
 * Ranked by bm25 with `ruling_id` as the tie-break, so the same corpus and the
 * same query always produce the same order — retrieval has to be reproducible
 * for a citation to mean anything.
 */
export function retrievePrecedents(args: RetrieveArgs): PriorRuling[] {
  const query = precedentQuery(args.text);
  if (!query) return [];
  const limit = Math.min(Math.max(args.limit ?? PRECEDENT_LIMIT, 1), 20);

  let hits: { ruling_id: number; rank: number }[];
  try {
    hits = db
      .prepare(
        `SELECT ruling_id, bm25(ruling_fts) AS rank
           FROM ruling_fts
          WHERE ruling_fts MATCH ? AND rulebook = ? AND case_id != ?
          ORDER BY rank, ruling_id
          LIMIT ?`,
      )
      .all(query, args.rulebook, args.excludeCaseId, limit) as { ruling_id: number; rank: number }[];
  } catch {
    // A malformed query or a missing index must degrade to "no precedents", never
    // to a failed ruling: the decision is still owed to the parties.
    return [];
  }

  const out: PriorRuling[] = [];
  for (const hit of hits) {
    // Read the record itself, not the index row — this is what makes a citation's
    // provenance checkable against `rulings`.
    const row = db
      .prepare("SELECT id, case_id, rulebook, decision, reasoning FROM rulings WHERE id = ?")
      .get(hit.ruling_id) as
      | { id: number; case_id: number; rulebook: string; decision: string; reasoning: string }
      | undefined;
    if (!row) continue;
    out.push({
      id: row.id,
      caseId: row.case_id,
      rulebook: row.rulebook,
      decision: row.decision,
      reasoning: row.reasoning,
    });
  }
  return out;
}

export type CitedPrecedent = {
  ruling_id: number;
  weight: number;
  case_id: number;
  rulebook: string;
  decision: string;
  reasoning: string;
  created_at: string;
};

/**
 * The precedents a ruling cites, with enough of each to verify the claim.
 *
 * Returning the ids alone would make "this ruling follows that one" an assertion
 * the reader has to take on trust; this returns the case it came from and what it
 * decided, so the lineage can be walked back to the source.
 */
export function citedPrecedents(rulingId: number): CitedPrecedent[] {
  return db
    .prepare(
      `SELECT c.cited_ruling_id AS ruling_id, c.weight,
              r.case_id, r.rulebook, r.decision, r.reasoning, r.created_at
         FROM ruling_citations c
         JOIN rulings r ON r.id = c.cited_ruling_id
        WHERE c.ruling_id = ?
        ORDER BY c.cited_ruling_id`,
    )
    .all(rulingId) as CitedPrecedent[];
}

/** Quarantine records for a case, for the operator's view. */
export function quarantinedEvidence(caseId: number) {
  return db
    .prepare("SELECT id, evidence_ref, rule_id, snippet, ruling_id, created_at FROM evidence_quarantine WHERE case_id = ? ORDER BY id")
    .all(caseId) as {
    id: number;
    evidence_ref: string;
    rule_id: string;
    snippet: string;
    ruling_id: number | null;
    created_at: string;
  }[];
}
