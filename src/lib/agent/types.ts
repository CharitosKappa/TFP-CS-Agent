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
  /**
   * Canonical RMA reference (e.g. "RMA5278") when the subject/thread cites one.
   * Set deterministically by the pipeline (regex, not the triage model) — the
   * most precise key for the Odoo return lookup.
   */
  rmaNumber?: string;
  customerEmail?: string;
  /** Discount/coupon code the customer mentions, if any (for Shopify lookup). */
  couponCode?: string;
  /** Shoe size the customer is asking about, if any (e.g. "42") — for availability. */
  productSize?: string;
  /**
   * The product the customer names (as written), when they didn't paste a link —
   * e.g. "Σανδάλια Fisherman Flatform - Μόκα Σουέντ". Used to infer the product's
   * CATEGORY for a size-filtered link when we can't resolve the exact product.
   */
  productName?: string;
  /**
   * A product code the customer quotes — an 8-digit colourway or 11-digit variant
   * SKU (e.g. "24037035") — even when written as a BARE number with no "SKU"
   * label. The regex extractor only catches "SKU:"-anchored numbers (to avoid
   * grabbing order/phone numbers), so the classifier is what captures the common
   * bare-code case. The most precise product key for the Shopify lookup.
   */
  productSku?: string;
  /**
   * The customer is explicitly asking to RECEIVE or RESEND the return courier
   * voucher/label (e.g. "δεν βρίσκω το voucher", "στείλτε μου ξανά την ετικέτα").
   * Trigger for attaching the real voucher PDF from Odoo to the reply.
   */
  asksForReturnLabel?: boolean;
  /**
   * Red-line categories the classifier detected SEMANTICALLY (language-agnostic),
   * as red-line keys (see redlines.ts). Complements the keyword detector so
   * escalation works across all customer languages, not just ones with keyword
   * lists. Merged into the red-line verdict in the pipeline.
   */
  escalationReasons?: string[];
  sentiment: "positive" | "neutral" | "negative";
  /**
   * The sender is not a customer at all but a third party running UNSOLICITED
   * B2B/commercial outreach — a supplier/manufacturer pitching products, wholesale
   * or sourcing, dropshipping, or an agency selling SEO/marketing/IT/web services,
   * investment, etc. These are skipped entirely (no draft, no reply, no task). Does
   * NOT include press/media/influencer or brand-collaboration inquiries, which
   * still escalate for a human (see the media_influencer red-line).
   */
  vendorPitch?: boolean;
  /** One-line summary of what the customer wants. */
  summary: string;
  /**
   * Whether this customer message actually needs a reply. false for a pure
   * closing/acknowledgment ("ευχαριστώ", "εντάξει, όλα καλά") with no new
   * request — those resolve the thread instead of drafting a reply.
   */
  requiresReply: boolean;
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
  /** Latest active return/RMA for this customer/order, from Odoo (read-only). */
  odooContext?: string;
  /**
   * A decision/action a human has now made for this case (e.g. "goodwill: €10
   * code T8K78DK91PW2, min €39, expires 31/7") that this reply must communicate
   * to the customer. Set by the follow-up processor after the Planner task is done.
   */
  resolutionContext?: string;
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
  /**
   * A hard caveat when a data source we NEEDED failed (e.g. the Odoo return
   * lookup threw), so the draft must not assert facts it couldn't verify — e.g.
   * telling a customer to "create an RMA" when we couldn't check whether one
   * already exists. Rendered prominently so the model stays neutral and defers.
   */
  dataCaveat?: string;
}

export interface DraftResult {
  content: string;
  /** Rationale surfaced to the human reviewer. */
  reasoning: string;
  classification: Classification;
  redline: RedLineVerdict;
  /**
   * Odoo ir.attachment id of the return courier voucher to attach to this reply,
   * set when the customer asked for it and the RMA has one. Persisted with the
   * draft; the binary is fetched from Odoo at send time (never stored locally).
   */
  voucherAttachmentId?: number;
  /**
   * Short essence of the follow-up action (e.g. "Απόφαση goodwill") — becomes a
   * clean Planner task title (order/customer appended by the caller). Internal.
   */
  followUpTitle?: string;
  /**
   * Detailed internal description of what the human must decide/do — goes in the
   * Planner task notes. Not shown to the customer.
   */
  followUpDetails?: string;
  /**
   * The reply defers/promises a follow-up from us rather than fully resolving
   * the request. On send, routes the conversation to AWAITING_FOLLOWUP so the
   * open obligation isn't lost. Declared by the drafting model.
   */
  promisesFollowUp: boolean;
}
