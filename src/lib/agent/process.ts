import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getMessageAttachments } from "../graph/messages";
import { loadPolicies } from "../knowledge/policies";
import { downscaleImage } from "../media/downscale";
import {
  isImageAttachment,
  isSupportedImageType,
  type InlineImage,
} from "../media/image";
import { errInfo, log } from "../observability/logger";
import { getRelatedConversations } from "../review/queue";
import { gatherShopifyContext } from "../shopify/context";
import { draftReplyForInbound } from "./pipeline";
import { updateCaseSummary } from "./summary";

// How many prior messages to include verbatim (older history lives in the summary).
const RECENT_LIMIT = 6;

// Image attachments fed to the draft model (vision). Bounded for cost/limits.
// Cap keeps base64 under Claude's ~5MB/image limit (3.5MB raw ≈ 4.6MB base64).
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3_500_000;

interface InboundMedia {
  images: InlineImage[];
  /** Text the model always sees, so it knows what was attached (even oversized/non-image). */
  summary?: string;
}

/**
 * Best-effort: fetch the customer message's attachments. Returns the image bytes
 * the model can "see" (vision, capped) PLUS a text summary of ALL attachments —
 * so the agent never re-asks for files/photos the customer already sent.
 */
async function fetchInboundMedia(graphMessageId: string): Promise<InboundMedia> {
  try {
    const attachments = await getMessageAttachments(graphMessageId);
    if (!attachments.length) return { images: [] };

    const imageAtts = attachments.filter(isImageAttachment);
    const fileAtts = attachments.filter((a) => !isImageAttachment(a));

    const images: InlineImage[] = [];
    for (const a of imageAtts) {
      if (images.length >= MAX_IMAGES) break;
      if (!a.contentBytes) continue;
      const ct = a.contentType.toLowerCase();
      // Trust the bytes we actually hold, not Graph's reported `size` — it can
      // be missing (defaulted to 0), which would let an oversized image through
      // un-downscaled and trip Claude's per-image limit (a 400 that kills the draft).
      const rawBytes = Math.floor((a.contentBytes.length * 3) / 4);
      if (isSupportedImageType(ct) && rawBytes <= MAX_IMAGE_BYTES) {
        images.push({ mediaType: ct, data: a.contentBytes });
      } else {
        // Too large or an unsupported type → downscale/re-encode to a safe JPEG.
        const ds = await downscaleImage(a.contentBytes);
        if (ds) images.push(ds);
      }
    }

    const parts: string[] = [];
    if (imageAtts.length) parts.push(`${imageAtts.length} εικόνα(ες)`);
    if (fileAtts.length) parts.push(`${fileAtts.length} αρχείο(α)`);
    const names = attachments.map((a) => a.name).join(", ");
    // Images the customer attached but we could NOT show the model (over the
    // count cap, missing bytes, unsupported type, or a failed downscale).
    const hidden = imageAtts.length - images.length;

    let summary = `Ο πελάτης ΕΧΕΙ ΕΠΙΣΥΝΑΨΕΙ ${parts.join(" + ")}: ${names}. Μην πεις στον πελάτη ότι δεν έλαβες αρχεία.`;
    if (images.length) {
      summary += ` ${images.length} από τις εικόνες εμφανίζονται παρακάτω ώστε να τις δεις — μην τις ξαναζητήσεις.`;
    }
    if (hidden > 0) {
      summary += ` ${hidden} εικόνα(ες) εστάλησαν αλλά ΔΕΝ εμφανίζονται εδώ (π.χ. μη υποστηριζόμενος τύπος, πολύ μεγάλο αρχείο ή πάνω από το όριο εικόνων)· αν χρειάζεσαι το περιεχόμενό τους για να απαντήσεις, ζήτησε ευγενικά από τον πελάτη να τις ξαναστείλει σε μορφή JPG/PNG.`;
    }
    if (fileAtts.length) {
      summary += ` Τα μη-εικονικά αρχεία (${fileAtts.length}) δεν εμφανίζονται εδώ αλλά έχουν ληφθεί και θα τα ελέγξει ο συνεργάτης — μην τα ξαναζητήσεις.`;
    }
    return { images, summary };
  } catch (e) {
    log.warn("attachment_fetch_failed", { ...errInfo(e) });
    return { images: [] };
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
  const media = await fetchInboundMedia(message.graphMessageId);

  // Cross-thread context: the same customer's other recent threads (e.g. ones
  // they opened instead of replying here, or about the same order). Best-effort.
  const relatedThreads = conv.customerEmail
    ? await getRelatedConversations(conv.id, conv.customerEmail, conv.orderNumber).catch(() => [])
    : [];
  const relatedContext = relatedThreads.length
    ? relatedThreads
        .map(
          (r) =>
            `- #${r.ref} «${r.subject ?? ""}»${r.sameOrder ? " (ίδια παραγγελία)" : ""}: ${r.summary ?? "—"}`,
        )
        .join("\n")
    : undefined;

  const result = await draftReplyForInbound({
    policies,
    caseSummary: conv.summary ?? "",
    recentMessages,
    incomingMessage: message.bodyText,
    subject: conv.subject ?? undefined,
    images: media.images,
    attachmentSummary: media.summary,
    relatedContext,
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
