import { classifyEmail } from "./classify";
import { generateDraft } from "./draft";
import { detectRedLines, ESCALATION_CONFIDENCE_THRESHOLD } from "./redlines";
import type { InlineImage } from "../media/image";
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
  /** Reviewer feedback fed back in when regenerating a rejected draft. */
  reviewerGuidance?: string;
  /** Compact summaries of the same customer's other recent threads (context only). */
  relatedContext?: string;
  /** Pre-computed classification — skips re-classifying when the caller already did. */
  classification?: Classification;
  /**
   * Lazily fetches Shopify context once the message is classified — gets the
   * extracted orderNumber/email so we only query what the message is about.
   */
  gatherShopify?: (classification: Classification) => Promise<string | undefined>;
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

  let shopifyContext = input.shopifyContext;
  if (!shopifyContext && input.gatherShopify) {
    try {
      shopifyContext = await input.gatherShopify(classification);
    } catch (e) {
      console.error("shopify gather failed:", e);
    }
  }

  // Red-line scan over subject + body (the subject can carry red-line wording too).
  const redline = detectRedLines(`${input.subject ?? ""}\n${input.incomingMessage}`);
  // Low classifier confidence is itself a red line.
  if (classification.confidence < ESCALATION_CONFIDENCE_THRESHOLD) {
    redline.escalate = true;
    if (!redline.reasons.includes("low_confidence")) {
      redline.reasons.push("low_confidence");
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
    relatedContext: input.relatedContext,
    reviewerGuidance: input.reviewerGuidance,
  };

  const { content } = await generateDraft(ctx);

  const reasoning =
    `intent=${classification.intent} confidence=${classification.confidence.toFixed(2)} ` +
    `sentiment=${classification.sentiment} escalate=${redline.escalate}` +
    (redline.reasons.length ? ` reasons=${redline.reasons.join(",")}` : "");

  return { content, reasoning, classification, redline };
}
