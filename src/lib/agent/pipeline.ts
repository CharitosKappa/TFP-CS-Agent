import { log, errInfo } from "../observability/logger";
import { classifyEmail } from "./classify";
import { generateDraft } from "./draft";
import { detectRedLines, ESCALATION_CONFIDENCE_THRESHOLD, RED_LINE_RULES } from "./redlines";
import type { InlineImage } from "../media/image";
import type { OdooGatherResult } from "../odoo/context";
import { extractRmaNumber } from "../odoo/rma";
import { resolveOrderFromIdentifiers } from "../odoo/order-lookup";
import { extractProductHandles } from "../shopify/products";
import { extractOrderNumber, resolveOrderName, stripNonOrderIdentifiers } from "../shopify/orders";
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
  /**
   * The VERIFIED sender email. Used to resolve a non-order identifier the customer
   * pasted (invoice/warehouse-move/tracking) to their real order — the lookup is
   * scoped to this address so it can only ever surface the sender's own order.
   */
  customerEmail?: string;
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

  // Backstop for a known misparse: digits lifted from a NON-order identifier the
  // customer pasted — an RMA ref ("RMA5278" → "5278"), a receipt/invoice series
  // ("ΑΛΠ/2026/-16839" → "16839"), or a warehouse-move name ("LGK/OUT/49573"). If
  // the number appears in what the classifier saw ONLY inside such a token, it's
  // not an order — drop it before resolveOrderName "confirms" a bogus/old order.
  if (classification.orderNumber) {
    const seen = `${input.subject ?? ""}\n${input.incomingMessage}`;
    const stripped = stripNonOrderIdentifiers(seen);
    if (seen.includes(classification.orderNumber) && !stripped.includes(classification.orderNumber)) {
      classification.orderNumber = undefined;
    }
  }

  // The RMA reference itself (e.g. "RMA5278" in the subject of our acceptance
  // email) is the most precise Odoo key — extract it deterministically so the
  // return lookup targets exactly the RMA the thread is about.
  if (!classification.rmaNumber) {
    const rma = extractRmaNumber(
      [input.subject ?? "", input.incomingMessage, ...input.recentMessages.map((m) => m.body)].join("\n"),
    );
    if (rma) classification.rmaNumber = rma;
  }

  // Resolve the order number from the subject + thread when the current message
  // omits it (e.g. a "cancel the order" follow-up) — so the order-keyed lookups,
  // Planner task title, and task supersede-by-order still work on a follow-up.
  if (!classification.orderNumber) {
    const fromThread = extractOrderNumber([input.subject ?? "", ...input.recentMessages.map((m) => m.body)].join("\n"));
    if (fromThread) classification.orderNumber = fromThread;
  }

  // Still no order number? The customer likely pasted a NON-order identifier —
  // a receipt/invoice series (ΑΛΠ/…), warehouse-move name (LGK/OUT/…) or the
  // parcel tracking number — which is why the RMA portal rejected them. Resolve
  // it to their real order via Odoo, scoped to the verified sender so it can only
  // surface their own order. This lets the draft hand them the number to use.
  if (!classification.orderNumber && input.customerEmail) {
    const text = [input.subject ?? "", input.incomingMessage, ...input.recentMessages.map((m) => m.body)].join("\n");
    const resolved = await resolveOrderFromIdentifiers(text, input.customerEmail).catch(() => null);
    if (resolved) classification.orderNumber = resolved;
  }

  // Reconcile the number to a REAL order: customers routinely paste the tracking/
  // shipment number thinking it's the order number (e.g. "9752358348" → order
  // #49841). Resolving it here means the Shopify/Odoo lookups, the draft, the task
  // title, and supersede-by-order all key off the same true order. Leave the value
  // untouched if it resolves to nothing, so a human still sees what the customer sent.
  if (classification.orderNumber) {
    const real = await resolveOrderName(classification.orderNumber).catch(() => null);
    if (real) classification.orderNumber = real;
  }

  // Gather external context concurrently — each is best-effort and isolated, so
  // one source failing (or being slow) never blocks the draft or the other source.
  let shopifyContext = input.shopifyContext;
  let odooContext = input.odooContext;
  let voucherAttachmentId: number | undefined;
  await Promise.all([
    (async () => {
      if (!shopifyContext && input.gatherShopify) {
        try {
          // Scan the whole thread, not just the new message: a follow-up ("is it
          // back in stock?") often no longer repeats the product link, so we'd
          // otherwise lose the product it refers to (and e.g. its notify-me state).
          const handleText = [input.incomingMessage, ...input.recentMessages.map((m) => m.body)].join("\n");
          const productHandles = extractProductHandles(handleText);
          shopifyContext = await input.gatherShopify(classification, { productHandles });
        } catch (e) {
          log.error("shopify_gather_failed", errInfo(e));
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
          log.error("odoo_gather_failed", errInfo(e));
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

  // Thread-aware: the customer has written back after OUR reply. This escalates
  // ONLY when there's a sign the previous answer didn't land — negative sentiment
  // or another red-line already firing. A positive/neutral follow-up is drafted
  // normally rather than auto-escalating every back-and-forth (reviewer noise).
  const lastPrior = input.recentMessages[input.recentMessages.length - 1];
  const wroteBackAfterOurReply = lastPrior?.direction === "OUTBOUND";
  if (wroteBackAfterOurReply && (classification.sentiment === "negative" || redline.escalate)) {
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

  const { content, promisesFollowUp, needsHumanAnswer, followUpTitle, followUpDetails } = await generateDraft(ctx);

  // The draft couldn't answer the customer's specific (usually product/technical)
  // question from the data — it only deferred. Escalate so a human with product
  // knowledge answers, using this draft as the base, rather than the deferral
  // being sent as the final word.
  if (needsHumanAnswer) {
    redline.escalate = true;
    if (!redline.reasons.includes("needs_human_answer")) redline.reasons.push("needs_human_answer");
  }

  const reasoning =
    `intent=${classification.intent} confidence=${classification.confidence.toFixed(2)} ` +
    `sentiment=${classification.sentiment} escalate=${redline.escalate}` +
    (promisesFollowUp ? " follow-up=ναι" : "") +
    (voucherAttachmentId ? " voucher=συνημμένο" : "") +
    (redline.reasons.length ? ` reasons=${redline.reasons.join(",")}` : "");

  return { content, reasoning, classification, redline, promisesFollowUp, followUpTitle, followUpDetails, voucherAttachmentId };
}
