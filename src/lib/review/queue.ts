// Read-side queries for the review dashboard.
import type { Prisma } from "@prisma/client";
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

export interface ConversationListItem {
  conversationId: string;
  ref: number;
  subject: string | null;
  customerEmail: string;
  customerName: string | null;
  status: string;
  orderNumber: string | null;
  /** Time of the latest message (falls back to the conversation's updatedAt). */
  lastActivity: Date;
  messageCount: number;
  latestDirection: string | null;
  preview: string;
  /** From the latest draft's classification, if any. */
  intent: string | null;
  isEscalated: boolean;
  /** Status of the latest draft, or null if none was ever generated. */
  draftStatus: string | null;
  /** True if every message is OUTBOUND — a thread we started, no customer reply yet. */
  outboundOnly: boolean;
}

/**
 * Every ingested conversation, newest-activity first — for the "all
 * conversations" browser. Unlike getReviewQueue (drafts only), this also
 * surfaces threads with no pending draft (already answered, RESOLVED,
 * automated), each tagged with its status. Read-only.
 */
export async function getAllConversations(): Promise<ConversationListItem[]> {
  const rows = await prisma.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      messages: {
        orderBy: { receivedAt: "desc" },
        take: 1,
        select: { bodyText: true, receivedAt: true, direction: true },
      },
      drafts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, isEscalated: true, classification: true },
      },
      _count: { select: { messages: true } },
    },
  });

  // Conversation ids with at least one INBOUND (customer) message; anything not
  // here is "outbound-only" — a thread we started with no customer reply yet.
  const withInbound = new Set(
    (
      await prisma.message.findMany({
        where: { direction: "INBOUND" },
        select: { conversationId: true },
        distinct: ["conversationId"],
      })
    ).map((m) => m.conversationId),
  );

  return rows.map((c): ConversationListItem => {
    const latest = c.messages[0];
    const draft = c.drafts[0];
    const cls = classificationOf(draft?.classification);
    return {
      conversationId: c.id,
      ref: c.ref,
      subject: c.subject,
      customerEmail: c.customerEmail,
      customerName: c.customerName,
      status: c.status,
      orderNumber: c.orderNumber,
      lastActivity: latest?.receivedAt ?? c.updatedAt,
      messageCount: c._count.messages,
      latestDirection: latest?.direction ?? null,
      preview: (latest?.bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      intent: cls?.intent ?? null,
      isEscalated: draft?.isEscalated ?? false,
      draftStatus: draft?.status ?? null,
      outboundOnly: c._count.messages > 0 && !withInbound.has(c.id),
    };
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

/** How far back to look for a customer's other threads. */
const RELATED_WINDOW_DAYS = 30;

export interface RelatedConversation {
  conversationId: string;
  ref: number;
  subject: string | null;
  status: string;
  lastActivity: Date;
  /** Rolling summary — fed to the agent as cross-thread context. */
  summary: string | null;
  /** Shares the current conversation's order number. */
  sameOrder: boolean;
}

/**
 * Other recent conversations from the same customer (or about the same order),
 * within RELATED_WINDOW_DAYS, self excluded. Surfaces threads a customer opened
 * as new instead of replying in-thread — for the reviewer panel and as
 * cross-thread context for the agent.
 */
export async function getRelatedConversations(
  conversationId: string,
  customerEmail: string,
  orderNumber: string | null,
): Promise<RelatedConversation[]> {
  const or: Prisma.ConversationWhereInput[] = [];
  if (customerEmail) or.push({ customerEmail });
  if (orderNumber) or.push({ orderNumber });
  if (!or.length) return [];

  const cutoff = new Date(Date.now() - RELATED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.conversation.findMany({
    where: { id: { not: conversationId }, updatedAt: { gte: cutoff }, OR: or },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: {
      id: true,
      ref: true,
      subject: true,
      status: true,
      updatedAt: true,
      summary: true,
      orderNumber: true,
    },
  });
  return rows.map((r) => ({
    conversationId: r.id,
    ref: r.ref,
    subject: r.subject,
    status: r.status,
    lastActivity: r.updatedAt,
    summary: r.summary,
    sameOrder: !!orderNumber && r.orderNumber === orderNumber,
  }));
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
