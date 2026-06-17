import { MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import { getEnv } from "../env";
import { fetchInboxMessages, fetchMessage } from "../graph/messages";
import type { GraphMessage, GraphRecipient } from "../graph/types";
import { htmlToText, stripQuotedReply } from "./html";

function addr(r?: GraphRecipient | null): { email: string; name: string | null } {
  return {
    email: r?.emailAddress?.address?.toLowerCase() ?? "",
    name: r?.emailAddress?.name ?? null,
  };
}

function toBodyText(msg: GraphMessage): string {
  const raw = msg.body?.content ?? msg.bodyPreview ?? "";
  const isHtml = (msg.body?.contentType ?? "").toLowerCase() === "html";
  return stripQuotedReply(isHtml ? htmlToText(raw) : raw);
}

export interface IngestResult {
  conversationCreated: boolean;
  messageCreated: boolean;
  conversationId: string;
}

/** Threads a Graph message into a Conversation and persists it (idempotent). */
export async function ingestGraphMessage(msg: GraphMessage): Promise<IngestResult> {
  const mailbox = getEnv().GRAPH_MAILBOX.toLowerCase();
  const from = addr(msg.from ?? msg.sender);
  const direction =
    from.email === mailbox ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;

  const toList = (msg.toRecipients ?? []).map(addr);
  // The customer is the external participant.
  const customer =
    direction === MessageDirection.INBOUND
      ? from
      : toList.find((t) => t.email && t.email !== mailbox) ?? { email: "", name: null };

  const existingConv = await prisma.conversation.findUnique({
    where: { graphConversationId: msg.conversationId },
    select: { id: true },
  });
  const existingMsg = await prisma.message.findUnique({
    where: { graphMessageId: msg.id },
    select: { id: true },
  });

  const conv = await prisma.conversation.upsert({
    where: { graphConversationId: msg.conversationId },
    create: {
      graphConversationId: msg.conversationId,
      subject: msg.subject ?? null,
      customerEmail: customer.email,
      customerName: customer.name,
      status: "NEW",
    },
    update: {
      customerEmail: customer.email || undefined,
      customerName: customer.name ?? undefined,
    },
  });

  if (existingMsg) {
    return { conversationCreated: false, messageCreated: false, conversationId: conv.id };
  }

  const isHtml = (msg.body?.contentType ?? "").toLowerCase() === "html";
  await prisma.message.create({
    data: {
      conversationId: conv.id,
      graphMessageId: msg.id,
      direction,
      fromEmail: from.email,
      toEmails: toList.map((t) => t.email).filter(Boolean),
      bodyText: toBodyText(msg),
      bodyHtml: isHtml ? msg.body?.content ?? null : null,
      receivedAt: new Date(msg.receivedDateTime),
    },
  });

  await prisma.auditLog.create({
    data: {
      conversationId: conv.id,
      actor: "ingestion",
      action: "message_ingested",
      detail: { graphMessageId: msg.id, direction },
    },
  });

  return {
    conversationCreated: !existingConv,
    messageCreated: true,
    conversationId: conv.id,
  };
}

/** Convenience for the webhook path: fetch a message by id, then ingest it. */
export async function ingestMessageById(id: string): Promise<IngestResult> {
  return ingestGraphMessage(await fetchMessage(id));
}

export interface SyncResult {
  fetched: number;
  newConversations: number;
  newMessages: number;
  skipped: number;
}

/** Manual pull of recent inbox messages → persisted, threaded conversations. */
export async function syncInbox(
  opts: { limit?: number; since?: Date } = {},
): Promise<SyncResult> {
  const messages = await fetchInboxMessages(opts);
  // Process oldest-first so within-conversation ordering is natural.
  const ordered = [...messages].sort(
    (a, b) =>
      new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
  );

  let newConversations = 0;
  let newMessages = 0;
  let skipped = 0;
  for (const msg of ordered) {
    const r = await ingestGraphMessage(msg);
    if (r.conversationCreated) newConversations++;
    if (r.messageCreated) newMessages++;
    else skipped++;
  }

  return { fetched: messages.length, newConversations, newMessages, skipped };
}
