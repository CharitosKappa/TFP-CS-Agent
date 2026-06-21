import type { InlineImage } from "../media/image";

export const INTENTS = [
  "order_status",
  "returns_refunds",
  "shipping",
  "payment",
  "product_question",
  "complaint",
  "cancellation",
  "other",
] as const;

export type Intent = (typeof INTENTS)[number];

export interface Classification {
  intent: Intent;
  /** 0..1 — drives low-confidence escalation. */
  confidence: number;
  /** ISO language code of the customer's message, e.g. "el", "en". */
  language: string;
  orderNumber?: string;
  customerEmail?: string;
  /** Discount/coupon code the customer mentions, if any (for Shopify lookup). */
  couponCode?: string;
  sentiment: "positive" | "neutral" | "negative";
  /** One-line summary of what the customer wants. */
  summary: string;
}

export interface RedLineVerdict {
  escalate: boolean;
  /** Matched red-line rule keys (e.g. "legal", "gdpr"). */
  reasons: string[];
}

/**
 * The bounded context assembled for each draft.
 * Cost stays ~flat regardless of thread length:
 *  - `policies` is identical across every email → cached system block (~0.1x).
 *  - `caseSummary` is a compact rolling state, updated incrementally per turn.
 *  - only the recent messages + new message + fresh Shopify data vary.
 */
export interface PromptContext {
  policies: string;
  caseSummary: string;
  recentMessages: { direction: "INBOUND" | "OUTBOUND"; body: string }[];
  incomingMessage: string;
  /** Email subject (often carries the order number, e.g. "Order43605"). */
  subject?: string;
  /** Image attachments from the customer's message, fed to the model (vision). */
  images?: InlineImage[];
  /** Text summary of ALL attachments, so the agent never re-asks for sent files. */
  attachmentSummary?: string;
  shopifyContext?: string;
  /**
   * Compact summaries of the SAME customer's other recent threads (e.g. ones they
   * opened instead of replying in-thread). Context only — the agent must answer
   * the current thread, not conflate them.
   */
  relatedContext?: string;
  /**
   * Guidance from a human reviewer who rejected the previous draft. Fed back
   * into the prompt so the regenerated draft corrects the flagged issue.
   */
  reviewerGuidance?: string;
}

export interface DraftResult {
  content: string;
  /** Rationale surfaced to the human reviewer. */
  reasoning: string;
  classification: Classification;
  redline: RedLineVerdict;
}
