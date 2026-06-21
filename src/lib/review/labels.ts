// Greek display labels + small formatting helpers for the review dashboard.
import { RED_LINE_RULES } from "@/lib/agent/redlines";
import type { Intent } from "@/lib/agent/types";

export const INTENT_LABELS: Record<Intent, string> = {
  order_status: "Κατάσταση παραγγελίας",
  returns_refunds: "Επιστροφές / Επιστροφή χρημάτων",
  shipping: "Αποστολή",
  payment: "Πληρωμή",
  product_question: "Ερώτηση προϊόντος",
  complaint: "Παράπονο",
  cancellation: "Ακύρωση",
  other: "Άλλο",
};

export const CONVERSATION_STATUS_LABELS: Record<string, string> = {
  NEW: "Νέο",
  AWAITING_REVIEW: "Προς έλεγχο",
  AWAITING_CUSTOMER: "Αναμονή πελάτη",
  ESCALATED: "Σε άνθρωπο",
  RESOLVED: "Λυμένο (χωρίς απάντηση)",
  CLOSED: "Κλειστό",
};

export const DRAFT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Εκκρεμεί",
  APPROVED: "Εγκρίθηκε",
  EDITED: "Επεξεργάστηκε",
  SENDING: "Σε αποστολή — χρειάζεται έλεγχος",
  REJECTED: "Απορρίφθηκε",
  SENT: "Στάλθηκε",
};

export const REVIEW_ACTION_LABELS: Record<string, string> = {
  APPROVE: "Έγκριση",
  EDIT: "Επεξεργασία",
  REJECT: "Απόρριψη",
};

// Maps a red-line rule key (or the synthetic "low_confidence") to a human reason.
const RED_LINE_DESCRIPTIONS: Record<string, string> = {
  ...Object.fromEntries(RED_LINE_RULES.map((r) => [r.key, r.description])),
  low_confidence: "Χαμηλή βεβαιότητα ταξινόμησης",
};

export function redLineLabel(key: string): string {
  return RED_LINE_DESCRIPTIONS[key] ?? key;
}

export function intentLabel(intent: string | null | undefined): string {
  if (!intent) return "—";
  return INTENT_LABELS[intent as Intent] ?? intent;
}

export function sentimentLabel(sentiment: string | null | undefined): string {
  return sentiment === "negative"
    ? "Αρνητικό"
    : sentiment === "positive"
      ? "Θετικό"
      : "Ουδέτερο";
}

export function sentimentBadgeClass(sentiment: string | null | undefined): string {
  if (sentiment === "negative") return "badge danger";
  if (sentiment === "positive") return "badge ok";
  return "badge neutral";
}

const RTF = new Intl.RelativeTimeFormat("el", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "πριν 3 ώρες" style relative time, computed against `now`. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "μόλις τώρα";
  for (const [unit, secs] of UNITS) {
    if (abs >= secs) return RTF.format(Math.round(seconds / secs), unit);
  }
  return "μόλις τώρα";
}

export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("el", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
