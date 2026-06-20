import type { RedLineVerdict } from "./types";

export interface RedLineRule {
  key: string;
  description: string;
  /**
   * Word-START (stem) matches: the term at a word boundary, trailing letters
   * allowed — e.g. "δικηγόρ" matches "δικηγόρος". Use for inflected Greek stems.
   */
  stems?: string[];
  /**
   * WHOLE-WORD matches: must not be part of a longer word — e.g. "sue" must NOT
   * match "suede". Use for short/ambiguous terms (esp. English).
   */
  words?: string[];
  /** Multi-word phrases: matched as a plain (normalized) substring. */
  phrases?: string[];
}

/**
 * Cases where the agent still drafts a reply, but the draft is flagged
 * "ανάληψη από άνθρωπο" and is never eligible for auto-send.
 *
 * Matching is boundary-aware (see detectRedLines): `stems` match a word prefix,
 * `words` match whole words only. This is what prevents "sue" from matching
 * "suede" or "γγε" from matching "αγγελία". The human reviewer remains the backstop.
 */
export const RED_LINE_RULES: RedLineRule[] = [
  {
    key: "legal",
    description: "Νομικές απειλές / δικηγόρος / αρχές καταναλωτή",
    stems: ["δικηγόρ", "μηνύσ", "συνήγορ", "καταγγελ", "νομικ"],
    words: ["sue", "lawyer", "lawsuit", "γγε"],
    phrases: ["legal action"],
  },
  {
    key: "gdpr",
    description: "GDPR / διαγραφή ή πρόσβαση προσωπικών δεδομένων",
    words: ["gdpr"],
    phrases: ["διαγραφή δεδομέν", "προσωπικά δεδομέν", "data deletion", "right to be forgotten"],
  },
  {
    key: "chargeback",
    description: "Chargeback / αμφισβήτηση χρέωσης / υποψία απάτης",
    stems: ["απατ", "fraud", "disput"],
    words: ["chargeback"],
    phrases: ["αμφισβήτηση χρέωσ", "ανάκληση χρέωσ"],
  },
  {
    key: "media_influencer",
    description: "Τύπος / influencer / συνεργασία / χονδρική",
    stems: ["δημοσιογράφ", "συνεργασ", "χονδρικ"],
    words: ["press", "wholesale", "blogger", "influencer"],
  },
  {
    key: "high_emotion",
    description: "Έντονα αρνητικό / απειλητικό ύφος",
    stems: ["απαράδεκτ", "ντροπ", "απατεών"],
    words: ["scam"],
    phrases: ["θα σας καταστρέψω"],
  },
  {
    key: "compensation",
    description: "Αίτημα αποζημίωσης",
    stems: ["αποζημ", "compensat", "διαφυγόντ"],
    phrases: ["ηθική βλάβη"],
  },
  {
    key: "health_safety",
    description: "Ζήτημα υγείας / αλλεργίας / τραυματισμού",
    stems: ["αλλεργ", "allerg", "παρενεργ", "ερεθισμ", "τραυματ", "injur"],
    words: ["rash"],
    phrases: ["side effect"],
  },
  {
    // Quality *complaints*, not routine defective-item returns (those go through
    // the normal RMA flow). Phrases only — complaint-flavoured wording.
    key: "quality_complaint",
    description: "Παράπονο ποιότητας προϊόντος",
    phrases: [
      "κακή ποιότητ",
      "κακής ποιότητ",
      "χαμηλή ποιότητ",
      "χαμηλής ποιότητ",
      "απαράδεκτη ποιότητ",
      "άθλια ποιότητ",
      "poor quality",
      "bad quality",
      "low quality",
      "terrible quality",
      "cheap quality",
    ],
  },
];

/** Minimum classification confidence below which we escalate to a human. */
export const ESCALATION_CONFIDENCE_THRESHOLD = 0.6;

/** Lowercase + strip diacritics so matching is accent-insensitive. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Precompiled matchers. Boundary = not adjacent to a Unicode letter or digit.
type RuleMatcher = { key: string; test: (hay: string) => boolean };

const RULE_MATCHERS: RuleMatcher[] = RED_LINE_RULES.map((rule) => {
  const stemRes = (rule.stems ?? []).map(
    (s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(normalize(s))}`, "u"),
  );
  const wordRes = (rule.words ?? []).map(
    (w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(normalize(w))}(?![\\p{L}\\p{N}])`, "u"),
  );
  const phrases = (rule.phrases ?? []).map((p) => normalize(p));
  return {
    key: rule.key,
    test: (hay: string) =>
      stemRes.some((re) => re.test(hay)) ||
      wordRes.some((re) => re.test(hay)) ||
      phrases.some((p) => hay.includes(p)),
  };
});

export function detectRedLines(text: string): RedLineVerdict {
  const hay = normalize(text);
  const reasons = RULE_MATCHERS.filter((m) => m.test(hay)).map((m) => m.key);
  return { escalate: reasons.length > 0, reasons };
}
