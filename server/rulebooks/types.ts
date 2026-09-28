import type { CaseDeadline, CaseKind, CaseRail, CaseRow } from "../cases.ts";

/**
 * The rulebook contract.
 *
 * A rulebook is everything that differs between one kind of money dispute and
 * another: where the evidence lives, what the governing rule is, what the clock
 * is, and what can actually be done about it. The arbiter knows none of that —
 * it gathers, asks, validates, persists and (only when a human confirms) calls
 * the rail's remedy. That split is what lets a second rail be added by writing
 * a rulebook rather than by touching the engine.
 */

/** One normalised piece of evidence, addressable by a stable id. */
export type EvidenceItem = {
  /** Stable across runs: "message:12", "delivery:1". Cited in a ruling's reasoning. */
  id: string;
  source: string;
  kind: CaseKind;
  body: string;
  ref?: string | null;
  at?: string | null;
};

export type EvidenceBundle = {
  caseId: number;
  rail: CaseRail;
  title: string;
  /** Everything the ruling may rest on, already fetched from the rail's own tables. */
  items: EvidenceItem[];
  /** Rail-specific background the model needs but that is not itself evidence. */
  context: Record<string, unknown>;
};

/**
 * The rule-derived reading of the evidence.
 *
 * `band` is a mechanical label, **not** a verdict: it records what the recorded
 * facts plainly show (did the freelancer deliver? is the report inside the RBI
 * window?) so the model reasons from a stated position instead of inventing one.
 * The ruling may disagree, and when it does the disagreement is visible in the
 * transcript.
 */
export type LiabilityAssessment = {
  band: string;
  /** The rule and facts the band rests on, quoted into the prompt. */
  basis: string;
  signals: Record<string, string | number | boolean | null>;
};

/** Something that can be done about a case. `id` is what the model must return. */
export type Remedy = {
  id: string;
  label: string;
  /** What confirming this does to the money, in words an operator can check. */
  effect: string;
  /** True when confirming this transfers lamports. */
  movesFunds: boolean;
};

/** What actually happened when a remedy was applied. */
export type RemedyOutcome = {
  remedy: string;
  applied: boolean;
  /** Rail-specific receipt (an on-chain signature, or why nothing moved). */
  detail: unknown;
};

/** A prior ruling, offered to the model as something it may cite. */
export type PriorRuling = {
  id: number;
  caseId: number;
  rulebook: string;
  decision: string;
  reasoning: string;
};

export type Rulebook = {
  id: string;
  name: string;
  /**
   * The deadline that governs this case, or null when nothing does. Null is a
   * real answer — see the escrow rulebook, where the contract, not a statute,
   * sets the timing.
   */
  deadline: (c: CaseRow) => CaseDeadline | null;
  liability: (bundle: EvidenceBundle) => LiabilityAssessment;
  remedies: Remedy[];
  systemPrompt: string;
  gatherEvidence: (c: CaseRow) => Promise<EvidenceBundle>;
  /**
   * Apply a remedy. Implementations must delegate the money movement to the
   * rail's existing code path — never to transfer logic of their own.
   */
  executeRemedy: (c: CaseRow, remedyId: string, actorId: number) => Promise<RemedyOutcome>;
};
