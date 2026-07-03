import { classifyEmail } from "./classify";
import { generateDraft } from "./draft";
import { detectRedLines, ESCALATION_CONFIDENCE_THRESHOLD, RED_LINE_RULES } from "./redlines";
import type { InlineImage } from "../media/image";
import type { OdooGatherResult } from "../odoo/context";
import { extractProductHandles } from "../shopify/products";
import type { Classification, DraftResult, PromptContext } from "./types";

export interface DraftReplyInput {
  /** Cached policy/knowledge text (see knowledge/policies.ts). */
  policies: string;
  /** Rolling case summary for this conversation ("" for a brand-new one). */
  caseSummary: string;
  recentMessages: PromptContext["recentMessages"];
  incomingMessage: string;
  /** Email subject — often carries the order number; seen by classify + draft. */
  subject?: string;
  /** Image attachments from the customer's message, fed to the draft model. */
  images?: InlineImage[];
  /** Text summary of all attachments (so the agent doesn't re-ask for sent files). */
  attachmentSummary?: string;
  /** Pre-computed Shopify context (takes precedence over gatherShopify). */
  shopifyContext?: string;
  /** Pre-computed Odoo/RMA context (takes precedence over gatherOdoo). */
  odooContext?: string;
  /** Reviewer feedback fed back in when regenerating a rejected draft. */
  reviewerGuidance?: string;
  /** Compact summaries of the same customer's other recent threads (context only). */
  relatedContext?: string;
  /** A human decision this reply must communicate (e.g. goodwill code + terms). */
  resolutionContext?: string;
  /** Pre-computed classification — skips re-classifying when the caller already did. */
  classification?: Classification;
  /**
   * Lazily fetches Shopify context once the message is classified — gets the
   * extracted orderNumber/email so we only query what the message is about, plus
   * any product handles found in the message body (for fit/size advice).
   */
  gatherShopify?: (
    classification: Classification,
    extras: { productHandles: string[] },
  ) => Promise<string | undefined>;
  /** Lazily fetches Odoo/RMA context once classified (text + optional voucher ref). */
  gatherOdoo?: (classification: Classification) => Promise<OdooGatherResult | undefined>;
}

/**
 * End-to-end for one inbound message: classify → gather Shopify → red-line gate → draft.
 * The caller persists the draft + escalation flags and surfaces it for review.
 */
export async function draftReplyForInbound(
  input: DraftReplyInput,
): Promise<DraftResult> {
  const classification =
    input.classification ?? (await classifyEmail(input.incomingMessage, input.subject));

  // Gather external context concurrently — each is best-effort and isolated, so
  // one source failing (or being slow) never blocks the draft or the other source.
  let shopifyContext = input.shopifyContext;
  let odooContext = input.odooContext;
  let voucherAttachmentId: number | undefined;
  await Promise.all([
    (async () => {
      if (!shopifyContext && input.gatherShopify) {
        try {
          const productHandles = extractProductHandles(input.incomingMessage);
          shopifyContext = await input.gatherShopify(classification, { productHandles });
        } catch (e) {
          console.error("shopify gather failed:", e);
        }
      }
    })(),
    (async () => {
      if (!odooContext && input.gatherOdoo) {
        try {
          const odoo = await input.gatherOdoo(classification);
          if (odoo) {
            odooContext = odoo.text;
            voucherAttachmentId = odoo.voucherAttachmentId;
          }
        } catch (e) {
          console.error("odoo gather failed:", e);
        }
      }
    })(),
  ]);

  // Red-line scan over subject + body (the subject can carry red-line wording too).
  const redline = detectRedLines(`${input.subject ?? ""}\n${input.incomingMessage}`);
  // Merge the classifier's SEMANTIC red-line detections — language-agnostic, so it
  // catches e.g. a compensation demand in German/Polish/… that no keyword list has.
  // Filtered to known red-line keys so a stray model output can't inject garbage.
  const validKeys = new Set(RED_LINE_RULES.map((r) => r.key));
  for (const key of classification.escalationReasons ?? []) {
    if (validKeys.has(key) && !redline.reasons.includes(key)) redline.reasons.push(key);
  }
  if (redline.reasons.length > 0) redline.escalate = true;
  // Low classifier confidence is itself a red line.
  if (classification.confidence < ESCALATION_CONFIDENCE_THRESHOLD) {
    redline.escalate = true;
    if (!redline.reasons.includes("low_confidence")) {
      redline.reasons.push("low_confidence");
    }
  }

  // Thread-aware: the last message in this thread is already OUR reply, yet the
  // customer has written back — our previous answer didn't resolve it, so a human
  // should take over the loop instead of auto-drafting another round. Deliberately
  // conservative: this also escalates a genuinely new follow-up question, which is
  // an acceptable trade-off in draft-only mode (every draft is human-reviewed, and
  // the reviewer still gets this draft as a starting point).
  const lastPrior = input.recentMessages[input.recentMessages.length - 1];
  if (lastPrior?.direction === "OUTBOUND") {
    redline.escalate = true;
    if (!redline.reasons.includes("repeat_after_reply")) {
      redline.reasons.push("repeat_after_reply");
    }
  }

  const ctx: PromptContext = {
    policies: input.policies,
    caseSummary: input.caseSummary,
    recentMessages: input.recentMessages,
    incomingMessage: input.incomingMessage,
    subject: input.subject,
    images: input.images,
    attachmentSummary: input.attachmentSummary,
    shopifyContext,
    odooContext,
    relatedContext: input.relatedContext,
    resolutionContext: input.resolutionContext,
    reviewerGuidance: input.reviewerGuidance,
  };

  const { content, promisesFollowUp, followUpTitle, followUpDetails } = await generateDraft(ctx);

  const reasoning =
    `intent=${classification.intent} confidence=${classification.confidence.toFixed(2)} ` +
    `sentiment=${classification.sentiment} escalate=${redline.escalate}` +
    (promisesFollowUp ? " follow-up=ναι" : "") +
    (voucherAttachmentId ? " voucher=συνημμένο" : "") +
    (redline.reasons.length ? ` reasons=${redline.reasons.join(",")}` : "");

  return { content, reasoning, classification, redline, promisesFollowUp, followUpTitle, followUpDetails, voucherAttachmentId };
}
