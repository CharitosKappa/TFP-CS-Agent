import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getMessageAttachments } from "../graph/messages";
import { loadPolicies } from "../knowledge/policies";
import { downscaleImage } from "../media/downscale";
import {
  isImageAttachment,
  sniffImageType,
  type InlineImage,
} from "../media/image";
import { errInfo, log } from "../observability/logger";
import { getRelatedConversations } from "../review/queue";
import { gatherOdooContext } from "../odoo/context";
import { gatherShopifyContext } from "../shopify/context";
import { classifyEmail } from "./classify";
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
      // Trust the actual bytes, not Graph's declared contentType: a mislabeled
      // image (e.g. a PNG content type on JPEG bytes) makes Claude reject the
      // whole request with a 400 that kills the draft. Sniff the real type from
      // the magic bytes; anything we can't positively identify as a supported
      // type falls through to the re-encode path below.
      const sniffed = sniffImageType(a.contentBytes);
      // Trust the bytes we actually hold, not Graph's reported `size` — it can
      // be missing (defaulted to 0), which would let an oversized image through
      // un-downscaled and trip Claude's per-image limit (a 400 that kills the draft).
      const rawBytes = Math.floor((a.contentBytes.length * 3) / 4);
      if (sniffed && rawBytes <= MAX_IMAGE_BYTES) {
        images.push({ mediaType: sniffed, data: a.contentBytes });
      } else {
        // Too large, or a type we couldn't positively identify → downscale/
        // re-encode to a safe JPEG.
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
  /** null when no reply was needed — the conversation was marked RESOLVED instead. */
  draftId: string | null;
  escalated: boolean;
  resolved: boolean;
}

export interface ProcessOptions {
  /** Reviewer feedback to fold into the prompt when re-drafting a rejection. */
  reviewerGuidance?: string;
  /**
   * Whether to fold the inbound message into the rolling summary. Default true;
   * set false on a re-draft so the same customer turn isn't counted twice.
   */
  updateSummary?: boolean;
  /**
   * Apply the "needs a reply?" gate (policy A): if the classifier judges the
   * message is a pure closing/acknowledgment, mark the conversation RESOLVED and
   * skip drafting. Only the automatic batch sets this; manual/redraft always draft.
   */
  applyClosingGate?: boolean;
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
  const { reviewerGuidance, updateSummary = true, applyClosingGate = false } = opts;
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

  // Classify first — it decides whether a reply is even needed.
  const classification = await classifyEmail(message.bodyText, conv.subject ?? undefined);

  // Policy A: a pure closing/acknowledgment needs no reply → mark the conversation
  // RESOLVED and skip drafting. Only the automatic batch applies this gate; a
  // reviewer-initiated redraft always drafts. RESOLVED auto-reopens on a new
  // inbound message (see ingestion/sync.ts).
  if (applyClosingGate && !classification.requiresReply) {
    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conv.id },
        data: { status: "RESOLVED" },
      });
      await tx.auditLog.create({
        data: {
          conversationId: conv.id,
          actor: "agent",
          action: "marked_resolved",
          detail: { reason: "no_reply_needed", intent: classification.intent },
        },
      });
    });
    log.info("conversation_resolved", { conversationId: conv.id, intent: classification.intent });
    return { draftId: null, escalated: false, resolved: true };
  }

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
    classification,
    gatherShopify: (c) =>
      gatherShopifyContext({
        orderNumber: c.orderNumber,
        // Fall back to the conversation's known customer email.
        customerEmail: c.customerEmail || conv.customerEmail,
        couponCode: c.couponCode,
        intent: c.intent,
      }),
    gatherOdoo: (c) =>
      gatherOdooContext({
        orderNumber: c.orderNumber,
        customerEmail: c.customerEmail || conv.customerEmail,
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
        promisesFollowUp: result.promisesFollowUp,
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
          promisesFollowUp: result.promisesFollowUp,
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

  return { draftId: draft.id, escalated: result.redline.escalate, resolved: false };
}

export interface BatchProcessResult {
  /** Conversations that got a draft reply. */
  processed: number;
  escalated: number;
  /** Conversations marked RESOLVED (last message needed no reply). */
  resolved: number;
}

/**
 * Drafts replies for conversations AWAITING our reply — i.e. whose LATEST message
 * is a customer (inbound) message that hasn't been drafted yet. Conversations
 * whose last word is already ours, or already drafted, or CLOSED/RESOLVED, are
 * skipped. A message the classifier judges needs no reply marks the conversation
 * RESOLVED instead of drafting (policy A).
 */
export async function processNewInboundMessages(
  limit = 10,
): Promise<BatchProcessResult> {
  // Candidate conversations, oldest-waiting first. Over-fetch, then keep only
  // those whose latest message is an inbound, not-yet-drafted one.
  const candidates = await prisma.conversation.findMany({
    where: { status: { notIn: ["CLOSED", "RESOLVED"] } },
    orderBy: { updatedAt: "asc" },
    take: limit * 4,
    select: {
      messages: {
        orderBy: { receivedAt: "desc" },
        take: 1,
        select: { id: true, direction: true, _count: { select: { drafts: true } } },
      },
    },
  });
  const messageIds = candidates
    .map((c) => c.messages[0])
    .filter((m) => m && m.direction === "INBOUND" && m._count.drafts === 0)
    .slice(0, limit)
    .map((m) => m!.id);

  const results: ProcessResult[] = [];
  let failed = 0;
  for (const id of messageIds) {
    try {
      const r = await processInboundMessage(id, { applyClosingGate: true });
      if (r) results.push(r);
    } catch (e) {
      failed++;
      log.error("draft_failed", { messageId: id, ...errInfo(e) });
    }
  }

  if (failed > 0) log.warn("draft_batch_partial_failure", { failed, ok: results.length });
  return {
    processed: results.filter((r) => !r.resolved).length,
    escalated: results.filter((r) => r.escalated).length,
    resolved: results.filter((r) => r.resolved).length,
  };
}
