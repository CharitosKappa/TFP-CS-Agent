import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getMessageAttachments } from "../graph/messages";
import { loadPolicies } from "../knowledge/policies";
import { errInfo, log } from "../observability/logger";
import { gatherShopifyContext } from "../shopify/context";
import { draftReplyForInbound } from "./pipeline";
import { updateCaseSummary } from "./summary";

// How many prior messages to include verbatim (older history lives in the summary).
const RECENT_LIMIT = 6;

// Image attachments fed to the draft model (vision). Bounded for cost/limits.
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4_000_000;

/** Best-effort: fetch the customer message's image attachments for the model. */
async function fetchInboundImages(
  graphMessageId: string,
): Promise<{ mediaType: string; data: string }[]> {
  try {
    const attachments = await getMessageAttachments(graphMessageId);
    return attachments
      .filter(
        (a) =>
          a.contentBytes &&
          SUPPORTED_IMAGE_TYPES.includes(a.contentType.toLowerCase()) &&
          a.size <= MAX_IMAGE_BYTES,
      )
      .slice(0, MAX_IMAGES)
      .map((a) => ({ mediaType: a.contentType.toLowerCase(), data: a.contentBytes as string }));
  } catch (e) {
    log.warn("attachment_fetch_failed", { ...errInfo(e) });
    return [];
  }
}

export interface ProcessResult {
  draftId: string;
  escalated: boolean;
}

export interface ProcessOptions {
  /** Reviewer feedback to fold into the prompt when re-drafting a rejection. */
  reviewerGuidance?: string;
  /**
   * Whether to fold the inbound message into the rolling summary. Default true;
   * set false on a re-draft so the same customer turn isn't counted twice.
   */
  updateSummary?: boolean;
}

/**
 * Produces a review-ready draft for one inbound message:
 *   load thread + rolling summary → classify → Shopify → red-line gate → draft
 *   → persist Draft → update rolling summary + conversation status.
 */
export async function processInboundMessage(
  messageId: string,
  opts: ProcessOptions = {},
): Promise<ProcessResult | null> {
  const { reviewerGuidance, updateSummary = true } = opts;
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      conversation: {
        include: { messages: { orderBy: { receivedAt: "asc" } } },
      },
    },
  });
  if (!message) throw new Error(`Message ${messageId} not found`);
  if (message.direction !== "INBOUND") return null; // only draft replies to customers

  const conv = message.conversation;

  const recentMessages = conv.messages
    .filter((m) => m.id !== message.id && m.receivedAt <= message.receivedAt)
    .slice(-RECENT_LIMIT)
    .map((m) => ({ direction: m.direction, body: m.bodyText }));

  const policies = await loadPolicies();
  const images = await fetchInboundImages(message.graphMessageId);

  const result = await draftReplyForInbound({
    policies,
    caseSummary: conv.summary ?? "",
    recentMessages,
    incomingMessage: message.bodyText,
    subject: conv.subject ?? undefined,
    images,
    reviewerGuidance,
    gatherShopify: (c) =>
      gatherShopifyContext({
        orderNumber: c.orderNumber,
        // Fall back to the conversation's known customer email.
        customerEmail: c.customerEmail || conv.customerEmail,
        couponCode: c.couponCode,
        intent: c.intent,
      }),
  });

  // Fold the customer's message into the rolling summary — keeps follow-ups cheap.
  // Skipped on a re-draft so the same inbound turn isn't summarised twice.
  // Done BEFORE the write so the external call can't strand a half-persisted state.
  const newSummary = updateSummary
    ? await updateCaseSummary(conv.summary ?? "", {
        direction: "INBOUND",
        body: message.bodyText,
      })
    : undefined;

  // Persist draft + conversation status/summary + audit atomically.
  const draft = await prisma.$transaction(async (tx) => {
    const created = await tx.draft.create({
      data: {
        conversationId: conv.id,
        triggerMessageId: message.id,
        content: result.content,
        reasoning: result.reasoning,
        classification: result.classification as unknown as Prisma.InputJsonValue,
        isEscalated: result.redline.escalate,
        escalationReasons: result.redline.reasons,
        status: "PENDING",
      },
    });
    await tx.conversation.update({
      where: { id: conv.id },
      data: {
        ...(newSummary !== undefined ? { summary: newSummary } : {}),
        status: result.redline.escalate ? "ESCALATED" : "AWAITING_REVIEW",
      },
    });
    await tx.auditLog.create({
      data: {
        conversationId: conv.id,
        draftId: created.id,
        actor: "agent",
        action: "draft_created",
        detail: {
          escalated: result.redline.escalate,
          reasons: result.redline.reasons,
          intent: result.classification.intent,
        },
      },
    });
    return created;
  });

  log.info("draft_created", {
    draftId: draft.id,
    conversationId: conv.id,
    escalated: result.redline.escalate,
    intent: result.classification.intent,
  });

  return { draftId: draft.id, escalated: result.redline.escalate };
}

export interface BatchProcessResult {
  processed: number;
  escalated: number;
}

/** Drafts replies for inbound messages that don't yet have one. */
export async function processNewInboundMessages(
  limit = 10,
): Promise<BatchProcessResult> {
  const messages = await prisma.message.findMany({
    where: {
      direction: "INBOUND",
      drafts: { none: {} },
      conversation: { status: { notIn: ["CLOSED"] } },
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const results: ProcessResult[] = [];
  let failed = 0;
  for (const m of messages) {
    try {
      const r = await processInboundMessage(m.id);
      if (r) results.push(r);
    } catch (e) {
      failed++;
      log.error("draft_failed", { messageId: m.id, ...errInfo(e) });
    }
  }

  if (failed > 0) log.warn("draft_batch_partial_failure", { failed, ok: results.length });
  return {
    processed: results.length,
    escalated: results.filter((r) => r.escalated).length,
  };
}
