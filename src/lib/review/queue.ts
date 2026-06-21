// Read-side queries for the review dashboard.
import { prisma } from "@/lib/db";
import type { Classification } from "@/lib/agent/types";

export interface QueueItem {
  conversationId: string;
  ref: number;
  draftId: string;
  draftStatus: string;
  subject: string | null;
  customerEmail: string;
  customerName: string | null;
  conversationStatus: string;
  intent: string | null;
  confidence: number | null;
  sentiment: string | null;
  isEscalated: boolean;
  escalationReasons: string[];
  /** When the triggering customer message arrived (falls back to draft time). */
  waitingSince: Date;
  preview: string;
  /** The triggering customer message carries a real image attachment. */
  hasImage: boolean;
}

function classificationOf(value: unknown): Classification | null {
  return (value as Classification | null) ?? null;
}

// Drafts that still need a human's attention: never reviewed (PENDING) or
// approved but not yet sent (e.g. a send that failed and needs a retry).
const ACTIONABLE_STATUSES = ["PENDING", "APPROVED", "EDITED"] as const;

/**
 * The review queue: every draft still awaiting a human decision (PENDING) or
 * approved-but-unsent, oldest first (FIFO) so nothing starves. Escalated items
 * are surfaced via flags and sorted to the top.
 */
export async function getReviewQueue(): Promise<QueueItem[]> {
  const drafts = await prisma.draft.findMany({
    where: { status: { in: [...ACTIONABLE_STATUSES] } },
    orderBy: { createdAt: "asc" },
    include: { conversation: true, triggerMessage: true },
  });

  const items = drafts.map((d): QueueItem => {
    const c = classificationOf(d.classification);
    const body = d.triggerMessage?.bodyText ?? "";
    return {
      conversationId: d.conversationId,
      ref: d.conversation.ref,
      draftId: d.id,
      draftStatus: d.status,
      subject: d.conversation.subject,
      customerEmail: d.conversation.customerEmail,
      customerName: d.conversation.customerName,
      conversationStatus: d.conversation.status,
      intent: c?.intent ?? null,
      confidence: c?.confidence ?? null,
      sentiment: c?.sentiment ?? null,
      isEscalated: d.isEscalated,
      escalationReasons: d.escalationReasons,
      waitingSince: d.triggerMessage?.receivedAt ?? d.createdAt,
      preview: body.replace(/\s+/g, " ").trim().slice(0, 160),
      hasImage: d.triggerMessage?.hasImageAttachment ?? false,
    };
  });

  // Escalated first, then oldest-waiting first.
  return items.sort((a, b) => {
    if (a.isEscalated !== b.isEscalated) return a.isEscalated ? -1 : 1;
    return a.waitingSince.getTime() - b.waitingSince.getTime();
  });
}

export async function getQueueCount(): Promise<number> {
  return prisma.draft.count({
    where: { status: { in: [...ACTIONABLE_STATUSES] } },
  });
}

export interface StuckSend {
  conversationId: string;
  ref: number;
  draftId: string;
  customerEmail: string;
  subject: string | null;
  since: Date;
}

/**
 * Drafts stuck in SENDING: the Graph send was attempted but the outcome wasn't
 * fully persisted (e.g. a crash/DB error after a successful send). These must be
 * surfaced for reconciliation — never silently dropped. See scripts/reconcile-sends.ts.
 */
export async function getStuckSends(): Promise<StuckSend[]> {
  const drafts = await prisma.draft.findMany({
    where: { status: "SENDING" },
    orderBy: { updatedAt: "asc" },
    include: { conversation: true },
  });
  return drafts.map((d) => ({
    conversationId: d.conversationId,
    ref: d.conversation.ref,
    draftId: d.id,
    customerEmail: d.conversation.customerEmail,
    subject: d.conversation.subject,
    since: d.updatedAt,
  }));
}

/** Full conversation with messages, all drafts (+ their reviews), newest draft first. */
export async function getConversationForReview(conversationId: string) {
  return prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { orderBy: { receivedAt: "asc" } },
      drafts: {
        orderBy: { createdAt: "desc" },
        include: { review: true, triggerMessage: true },
      },
    },
  });
}

export async function getAuditLog(conversationId: string) {
  return prisma.auditLog.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });
}

export type ConversationForReview = NonNullable<
  Awaited<ReturnType<typeof getConversationForReview>>
>;
