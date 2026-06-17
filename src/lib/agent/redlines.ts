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
    keywords: ["απαράδεκτο", "ντροπή", "καταγγελλω", "θα σας καταστρέψω", "scam", "απατεών"],
  },
];

/** Minimum classification confidence below which we escalate to a human. */
export const ESCALATION_CONFIDENCE_THRESHOLD = 0.6;

export function detectRedLines(text: string): RedLineVerdict {
  const lower = text.toLowerCase();
  const reasons = RED_LINE_RULES.filter((rule) =>
    rule.keywords.some((kw) => lower.includes(kw)),
  ).map((rule) => rule.key);
  return { escalate: reasons.length > 0, reasons };
}
