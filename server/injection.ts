import type { EvidenceBundle, EvidenceItem } from "./rulebooks/types.ts";

/**
 * Instruction-shaped evidence detection.
 *
 * Deterministic and offline: no model decides what counts as an injection, so
 * the same evidence always produces the same verdict and the answer never
 * depends on a network call.
 *
 * The hard problem here is not catching injections, it is *not* catching
 * ordinary dispute narrative. A false positive is not a harmless warning: the
 * withheld item never reaches the arbiter, so a freelancer who writes "please
 * release my payment" would silently lose the argument they were making. Every
 * rule below is therefore anchored on framing that is directed *at a reader
 * playing the model's role* — an override attempt, an AI persona, a role marker,
 * a format coercion — rather than on the subject matter of the dispute. Talking
 * about money, release, or approval is what a dispute *is*; telling the reader
 * that it is an instruction is what an injection is.
 */

export type InjectionRule = {
  id: string;
  label: string;
  pattern: RegExp;
  /** A strong rule withholds on its own; weak rules need corroboration. */
  strong: boolean;
  /**
   * Whether this rule's hit may count toward the corroboration threshold.
   *
   * Invisible characters are the counter-example: they arrive as a paste artifact
   * from any word processor, so they are worth reporting and stripping but must
   * never be half of the reason an argument is withheld. A rule that cannot carry
   * weight on its own is still evidence when paired with one that can.
   */
  corroborates?: boolean;
};

/** How many weak rules on one item are enough to withhold it. */
export const WEAK_RULE_THRESHOLD = 2;

export const INJECTION_RULES: InjectionRule[] = [
  // --- strong: an attempt to overwrite the arbiter's instructions ---------------
  {
    id: "override_instructions",
    label: "asks the reader to discard its instructions",
    strong: true,
    pattern:
      /\b(ignore|disregard|forget|override|bypass|overrule)\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|foregoing|initial)\b[^.!?\n]{0,24}\b(instruction|prompt|rule|direction|message)s?\b/i,
  },
  {
    id: "disregard_context",
    label: "asks the reader to disregard what came before",
    strong: true,
    pattern: /\b(ignore|disregard|forget)\s+(the\s+)?(above|everything|all\s+of\s+the\s+above|context|evidence)\b/i,
  },
  {
    id: "ai_persona",
    label: "addresses the reader as an AI and reassigns its role",
    strong: true,
    pattern:
      /\b(you\s+are\s+(now\s+)?(an?\s+)?(ai|a\.i\.|assistant|arbiter|model|bot|judge)\b|act\s+as\s+(an?\s+)?(ai|assistant|arbiter|model)\b|as\s+the\s+(ai|assistant|arbiter|model)\b)/i,
  },
  {
    id: "role_marker",
    label: "imitates a chat role marker",
    strong: true,
    pattern: /(^|\n)\s*(\[|<\|)?\s*(system|assistant|developer|tool|function)\s*(\]|>\|)?\s*[:>]/i,
  },
  {
    // Our own prompt fences the evidence this way. Evidence containing the fence
    // is an attempt to close the block and have the rest read as instructions.
    id: "fence_escape",
    label: "reproduces the evidence delimiter used by the prompt",
    strong: true,
    pattern: /(<<<\s*EVIDENCE|EVIDENCE\s*>>>)/i,
  },
  {
    // Section headers of the arbitration prompt. A body that prints one of these
    // is trying to look like part of the harness rather than like a claim.
    id: "preamble_mimicry",
    label: "reproduces a section heading of the arbitration prompt",
    strong: true,
    pattern:
      /(^|\n)\s*(REMEDIES\s*\(|CONTRACT\s+CONTEXT\b|RULE-DERIVED\s+READING\b|GOVERNING\s+CLOCK\b|PRECEDENTS\s*\(|EVIDENCE\s*>>>)/i,
  },
  {
    id: "format_coercion",
    label: "tells the reader to answer in a machine format",
    strong: true,
    pattern: /\b(return|respond|reply|output|print|answer)\b[^.!?\n]{0,24}\b(json|json\s+object|valid\s+json|yaml|xml)\b/i,
  },

  // --- weak: suspicious only with corroboration ---------------------------------
  {
    id: "authority_claim",
    label: "claims platform review authority",
    strong: false,
    // Deliberately NOT a bare "I am the admin", and deliberately not "I approve
    // the release": a buyer writing "I am the admin of the buying company" is
    // describing their own company, and a buyer approving a release is just doing
    // their job. Only impersonating *us* counts.
    pattern:
      /\b(i\s+am|i'm)\s+(the\s+)?(arbiter|operator|moderator|ai\s+arbiter|support\s+(agent|staff|team)|platform\s+(admin|administrator))\b/i,
  },
  {
    id: "concealment",
    label: "asks for something to be hidden from review",
    strong: false,
    // Deliberately omits "tell": "don't tell the buyer, but I can redo it" is how
    // parties talk to each other, and firing there would flag honest narrative on
    // a verb that carries no suppression on its own. "Mention", "report", "log",
    // "record", "audit" and "disclose" only surface when a party is trying to
    // keep something out of the record.
    pattern: /\b(do\s+not|don'?t)\s+(mention|report|log|record|audit|disclose)\b/i,
  },
  {
    id: "invisible_characters",
    label: "contains invisible or direction-override characters",
    strong: false,
    // Reported and stripped, but deliberately does not corroborate.
    corroborates: false,
    pattern: /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/,
  },
];

export type InjectionFinding = {
  /** The evidence item this was found in ("message:12"), for traceability. */
  evidenceRef: string;
  source: string;
  ruleId: string;
  label: string;
  strong: boolean;
  /** The matched text, clipped — for the human reviewer, never for the model. */
  match: string;
};

const MAX_SNIPPET = 200;

function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_SNIPPET ? `${t.slice(0, MAX_SNIPPET)}…` : t;
}

/** Rules that fired against one piece of text. */
export function scanText(text: string): { rule: InjectionRule; match: string }[] {
  if (!text) return [];
  const hits: { rule: InjectionRule; match: string }[] = [];
  for (const rule of INJECTION_RULES) {
    const m = rule.pattern.exec(text);
    if (m) hits.push({ rule, match: clip(m[0]) });
  }
  return hits;
}

/** True when a single item's hits justify withholding it from the model. */
export function shouldQuarantine(hits: { rule: InjectionRule }[]): boolean {
  if (hits.some((h) => h.rule.strong)) return true;
  return hits.filter((h) => h.rule.corroborates !== false).length >= WEAK_RULE_THRESHOLD;
}

export const QUARANTINE_MARK = "[QUARANTINED";

/** The text the model sees in place of withheld evidence. Never the original. */
export function quarantinePlaceholder(ruleIds: string[]): string {
  return (
    `${QUARANTINE_MARK} — instruction-shaped content withheld from the arbiter and flagged for ` +
    `human review (${ruleIds.join(", ")}). The original text is preserved in the case evidence.]`
  );
}

/**
 * Text that reaches the model is collapsed to a single line.
 *
 * Each evidence item is rendered as one `[id] (kind) source: body` line inside a
 * fenced block, so a body containing newlines could otherwise print lines that
 * look like further evidence items — or like prompt headings — without ever
 * triggering a rule above. Normalising the *rendering* costs nothing and cannot
 * alter what the reviewer sees, because the stored row is never touched.
 */
export function normalizeForPrompt(text: string): string {
  return text
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SanitizedBundle = {
  /** The bundle to render into the prompt: quarantined items replaced, others normalised. */
  bundle: EvidenceBundle;
  findings: InjectionFinding[];
  /** True when anything fired, including a lone weak rule that was not withheld. */
  suspicious: boolean;
  /** Item ids withheld from the model. */
  quarantinedRefs: string[];
};

/**
 * Scan a bundle and produce the version that may be shown to a model.
 *
 * Nothing here writes to the database: the caller persists the findings, and the
 * evidence rows themselves stay exactly as the parties wrote them.
 */
export function sanitizeBundle(bundle: EvidenceBundle): SanitizedBundle {
  const findings: InjectionFinding[] = [];
  const quarantinedRefs: string[] = [];

  const items: EvidenceItem[] = bundle.items.map((item) => {
    const hits = scanText(item.body);
    if (hits.length === 0) return { ...item, body: normalizeForPrompt(item.body) };

    for (const hit of hits) {
      findings.push({
        evidenceRef: item.id,
        source: item.source,
        ruleId: hit.rule.id,
        label: hit.rule.label,
        strong: hit.rule.strong,
        match: hit.match,
      });
    }

    if (!shouldQuarantine(hits)) {
      // Flagged, but the text still explains the dispute — withholding it would
      // throw away a real argument over one weak signal.
      return { ...item, body: normalizeForPrompt(item.body) };
    }

    quarantinedRefs.push(item.id);
    return { ...item, body: quarantinePlaceholder(hits.map((h) => h.rule.id)) };
  });

  return {
    bundle: { ...bundle, items },
    findings,
    suspicious: findings.length > 0,
    quarantinedRefs,
  };
}
