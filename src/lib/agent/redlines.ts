import type { RedLineVerdict } from "./types";

export interface RedLineRule {
  key: string;
  description: string;
  /** Lowercase substrings matched against the email text. */
  keywords: string[];
}

/**
 * Cases where the agent still drafts a reply, but the draft is flagged
 * "ανάληψη από άνθρωπο" and is never eligible for auto-send.
 * Keyword matching is the v1 detector; Phase 3 adds model-based detection.
 */
export const RED_LINE_RULES: RedLineRule[] = [
  {
    key: "legal",
    description: "Νομικές απειλές / δικηγόρος / αρχές καταναλωτή",
    keywords: [
      "δικηγόρ",
      "μήνυση",
      "μηνύσ",
      "συνήγορο",
      "γγε",
      "καταγγελ",
      "νομικ",
      "lawyer",
      "lawsuit",
      "sue",
      "legal action",
    ],
  },
  {
    key: "gdpr",
    description: "GDPR / διαγραφή ή πρόσβαση προσωπικών δεδομένων",
    keywords: ["gdpr", "διαγραφή δεδομέν", "προσωπικά δεδομέν", "data deletion", "right to be forgotten"],
  },
  {
    key: "chargeback",
    description: "Chargeback / αμφισβήτηση χρέωσης / υποψία απάτης",
    keywords: ["chargeback", "αμφισβήτηση χρέωσ", "απάτη", "fraud", "dispute", "ανάκληση χρέωσ"],
  },
  {
    key: "media_influencer",
    description: "Τύπος / influencer / συνεργασία / χονδρική",
    keywords: ["δημοσιογράφ", "influencer", "συνεργασ", "χονδρικ", "wholesale", "press", "blogger"],
  },
  {
    key: "high_emotion",
    description: "Έντονα αρνητικό / απειλητικό ύφος",
    // Note: "καταγγελ*" is already covered by the `legal` rule, so it's omitted here.
    keywords: ["απαράδεκτο", "ντροπή", "θα σας καταστρέψω", "scam", "απατεών"],
  },
  {
    key: "compensation",
    description: "Αίτημα αποζημίωσης",
    keywords: ["αποζημ", "compensation", "compensate", "ηθική βλάβη", "διαφυγόντα"],
  },
  {
    key: "health_safety",
    description: "Ζήτημα υγείας / αλλεργίας / τραυματισμού",
    keywords: ["αλλεργ", "allergy", "allergic", "παρενέργ", "ερεθισμ", "rash", "τραυματ", "injur", "side effect"],
  },
  {
    // Quality *complaints*, not routine defective-item returns (those go through
    // the normal RMA flow). Keyword matching here is intentionally narrow —
    // complaint-flavoured phrasings only — so it doesn't over-escalate every
    // defective-return question; the human reviewer remains the backstop.
    key: "quality_complaint",
    description: "Παράπονο ποιότητας προϊόντος",
    keywords: [
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

/**
 * Lowercase + strip diacritics (Greek tonos/dialytika) so matching is
 * accent-insensitive (e.g. "απατεών" === "απατεων"). Keyword matching is the v1
 * detector and is intentionally broad; the human reviewer is the backstop.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip combining diacritics
}

export function detectRedLines(text: string): RedLineVerdict {
  const haystack = normalize(text);
  const reasons = RED_LINE_RULES.filter((rule) =>
    rule.keywords.some((kw) => haystack.includes(normalize(kw))),
  ).map((rule) => rule.key);
  return { escalate: reasons.length > 0, reasons };
}
