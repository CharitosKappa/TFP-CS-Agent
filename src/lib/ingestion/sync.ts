import { MessageDirection } from "@prisma/client";
import { prisma } from "../db";
import { getEnv } from "../env";
import {
  fetchConversationThread,
  fetchInboxMessages,
  fetchMessage,
  fetchSentMessages,
  messageHasImageAttachment,
} from "../graph/messages";
import type { GraphMessage, GraphRecipient } from "../graph/types";
import { errInfo, log } from "../observability/logger";
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
  const env = getEnv();
  // "Us" = any address on the mailbox's own domain (support@, info@, eshop@, …)
  // OR a configured alias domain (e.g. the *.onmicrosoft.com tenant domain) — not
  // just GRAPH_MAILBOX, otherwise a reply from a sibling address is mistaken for
  // the customer. The customer is the first EXTERNAL participant.
  const mailboxDomain = env.GRAPH_MAILBOX.toLowerCase().split("@")[1] ?? "";
  const internalDomains = new Set(
    [mailboxDomain, ...(env.INTERNAL_EMAIL_DOMAINS ?? "").split(",")]
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
  const isInternal = (email: string) => {
    const at = email.lastIndexOf("@");
    return at !== -1 && internalDomains.has(email.slice(at + 1));
  };

  const from = addr(msg.from ?? msg.sender);
  const toList = (msg.toRecipients ?? []).map(addr);
  const direction = isInternal(from.email)
    ? MessageDirection.OUTBOUND
    : MessageDirection.INBOUND;
  const customer =
    [from, ...toList].find((p) => p.email && !isInternal(p.email)) ?? { email: "", name: null };

  const existingConv = await prisma.conversation.findUnique({
    where: { graphConversationId: msg.conversationId },
    select: { id: true },
  });
  // Dedupe across folders: the same reply has different Graph ids in Drafts/Sent,
  // but a stable internetMessageId — so a message we recorded when sending in-app
  // isn't re-created when it later turns up in Sent Items (and vice-versa).
  const existingMsg = await prisma.message.findFirst({
    where: {
      OR: [
        { graphMessageId: msg.id },
        ...(msg.internetMessageId ? [{ internetMessageId: msg.internetMessageId }] : []),
      ],
    },
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

  // Detect a real image attachment once, at ingest (best-effort — a lookup
  // failure must not block ingest). We check EVERY inbound message rather than
  // gating on Graph's `hasAttachments`, because that flag is false when a
  // message's only images are INLINE (cid:) — exactly the customer photos we
  // care about (e.g. mobile clients embed the photo in the body).
  const hasImageAttachment =
    direction === MessageDirection.INBOUND
      ? await messageHasImageAttachment(msg.id).catch(() => false)
      : false;

  await prisma.message.create({
    data: {
      conversationId: conv.id,
      graphMessageId: msg.id,
      internetMessageId: msg.internetMessageId ?? null,
      direction,
      fromEmail: from.email,
      toEmails: toList.map((t) => t.email).filter(Boolean),
      bodyText: toBodyText(msg),
      receivedAt: new Date(msg.receivedDateTime),
      hasImageAttachment,
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

/**
 * Manual pull of recent mailbox activity → persisted, threaded conversations.
 *
 * Discovers the conversations touched recently (across Inbox + Sent Items), then
 * pulls each COMPLETE thread (all folders) so we never persist a half thread —
 * e.g. our replies without the customer's messages, which can sit in a different
 * folder or fall outside a per-folder window.
 */
export async function syncInbox(
  opts: { limit?: number; since?: Date } = {},
): Promise<SyncResult> {
  const [inbox, sent] = await Promise.all([
    fetchInboxMessages(opts),
    fetchSentMessages(opts),
  ]);
  const conversationIds = [
    ...new Set([...inbox, ...sent].map((m) => m.conversationId).filter(Boolean)),
  ];

  // Pull each full thread, dedupe by Graph id, then ingest oldest-first.
  const collected: GraphMessage[] = [];
  for (const cid of conversationIds) {
    try {
      collected.push(...(await fetchConversationThread(cid)));
    } catch (e) {
      log.warn("thread_fetch_failed", { conversationId: cid, ...errInfo(e) });
    }
  }
  const seen = new Set<string>();
  const ordered = collected
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort(
      (a, b) =>
        new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
    );

  let newConversations = 0;
  let newMessages = 0;
  let skipped = 0;
  for (const msg of ordered) {
    // One bad message must not abort the whole batch.
    try {
      const r = await ingestGraphMessage(msg);
      if (r.conversationCreated) newConversations++;
      if (r.messageCreated) newMessages++;
      else skipped++;
    } catch (e) {
      skipped++;
      log.warn("ingest_message_failed", { graphMessageId: msg.id, ...errInfo(e) });
    }
  }

  return { fetched: ordered.length, newConversations, newMessages, skipped };
}
