import { isInlineCruft } from "../media/image";
import { getEnv } from "../env";
import { graphFetch } from "./client";
import type { GraphListResponse, GraphMessage } from "./types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const SELECT = [
  "id",
  "conversationId",
  "subject",
  "from",
  "sender",
  "toRecipients",
  "body",
  "bodyPreview",
  "receivedDateTime",
  "isRead",
  "hasAttachments",
  "internetMessageId",
].join(",");

function mailboxPath(): string {
  return `/users/${encodeURIComponent(getEnv().GRAPH_MAILBOX)}`;
}

/** Builds an OData query string: keys literal, values percent-encoded. */
function odata(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

/** Fetches recent inbox messages (newest first), paging up to `limit`. */
export async function fetchInboxMessages(
  opts: { limit?: number; since?: Date } = {},
): Promise<GraphMessage[]> {
  const limit = opts.limit ?? 25;
  const params: Record<string, string> = {
    $select: SELECT,
    $top: String(Math.min(limit, 50)),
    $orderby: "receivedDateTime desc",
  };
  if (opts.since) params.$filter = `receivedDateTime ge ${opts.since.toISOString()}`;

  let next: string | null = `${mailboxPath()}/mailFolders/inbox/messages?${odata(params)}`;
  const out: GraphMessage[] = [];
  while (next && out.length < limit) {
    const rel: string = next.startsWith("http") ? next.slice(GRAPH_BASE.length) : next;
    const res = await graphFetch(rel);
    const data = (await res.json()) as GraphListResponse<GraphMessage>;
    out.push(...data.value);
    next = data["@odata.nextLink"] ?? null;
  }
  return out.slice(0, limit);
}

/** Fetches a single message by id from the shared mailbox. */
export async function fetchMessage(id: string): Promise<GraphMessage> {
  const res = await graphFetch(
    `${mailboxPath()}/messages/${encodeURIComponent(id)}?${odata({ $select: SELECT })}`,
  );
  return (await res.json()) as GraphMessage;
}

export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentId: string | null;
  /** base64 file bytes (fileAttachment only). */
  contentBytes: string | null;
}

interface RawAttachment {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentId?: string | null;
  contentBytes?: string | null;
}

/**
 * Fetches a message's file attachments on-demand (not stored — see PRIVACY.md).
 * Returns only genuine fileAttachments the customer attached (which carry
 * contentBytes). Item/reference attachments are skipped, and so is inline CRUFT
 * (small cid: images — signature logos, tracking pixels). Large inline images
 * are KEPT: many mail clients embed a real customer photo inline. See
 * isInlineCruft.
 */
export async function getMessageAttachments(
  graphMessageId: string,
): Promise<GraphAttachment[]> {
  const res = await graphFetch(
    `${mailboxPath()}/messages/${encodeURIComponent(graphMessageId)}/attachments`,
  );
  const data = (await res.json()) as GraphListResponse<RawAttachment>;
  return data.value
    .filter((a) => (a["@odata.type"] ?? "").includes("fileAttachment"))
    .filter((a) => !isInlineCruft({ isInline: !!a.isInline, size: a.size ?? 0 }))
    .map((a) => ({
      id: a.id,
      name: a.name ?? "file",
      contentType: a.contentType ?? "application/octet-stream",
      size: a.size ?? 0,
      isInline: !!a.isInline,
      contentId: a.contentId ?? null,
      contentBytes: a.contentBytes ?? null,
    }));
}

/**
 * Cheap, metadata-only check (does NOT download contentBytes) for whether a
 * message carries a real, non-inline image attachment. Used at ingest to set a
 * flag the review queue can show without re-fetching attachments per render.
 */
export async function messageHasImageAttachment(graphMessageId: string): Promise<boolean> {
  const res = await graphFetch(
    `${mailboxPath()}/messages/${encodeURIComponent(graphMessageId)}/attachments?${odata({
      $select: "contentType,isInline,size",
    })}`,
  );
  const data = (await res.json()) as GraphListResponse<RawAttachment>;
  return data.value.some((a) => {
    // @odata.type may be omitted under $select; fall back to the contentType.
    const type = a["@odata.type"] ?? "";
    const isFile = type === "" || type.includes("fileAttachment");
    const isImage = (a.contentType ?? "").toLowerCase().startsWith("image/");
    return isFile && isImage && !isInlineCruft({ isInline: !!a.isInline, size: a.size ?? 0 });
  });
}

export interface SentReply {
  /**
   * Id of the reply message (the Drafts copy that was sent). It differs from the
   * eventual Sent Items id; this is fine because ingestion only reads the INBOX
   * (sync.ts), so a self-sent reply is never re-ingested. If Sent Items ingestion
   * is ever added, dedupe OUTBOUND on internetMessageId instead of this id.
   */
  graphMessageId: string;
  conversationId: string;
  toEmails: string[];
}

/**
 * Sends a reply in the original thread, preserving threading (RE: subject,
 * In-Reply-To/References headers, conversationId): createReply → set our body →
 * send. Replies go to the sender of the original (the customer).
 */
export async function sendReplyInThread(
  originalGraphMessageId: string,
  bodyHtml: string,
): Promise<SentReply> {
  const id = encodeURIComponent(originalGraphMessageId);
  // These three calls are non-idempotent — never auto-retry them, or a
  // lost-response timeout/5xx could double-send the email or orphan reply drafts.
  const noRetry = { retries: 0 } as const;

  // 1. Create a reply draft pre-populated with recipients/subject/threading.
  const created = await graphFetch(
    `${mailboxPath()}/messages/${id}/createReply`,
    { method: "POST" },
    noRetry,
  );
  const draft = (await created.json()) as GraphMessage;
  const draftId = encodeURIComponent(draft.id);

  // 2. Replace the body with our drafted reply.
  await graphFetch(
    `${mailboxPath()}/messages/${draftId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ body: { contentType: "HTML", content: bodyHtml } }),
    },
    noRetry,
  );

  // 3. Send. Returns 202 Accepted with no body.
  await graphFetch(`${mailboxPath()}/messages/${draftId}/send`, { method: "POST" }, noRetry);

  return {
    graphMessageId: draft.id,
    conversationId: draft.conversationId,
    toEmails: (draft.toRecipients ?? [])
      .map((r) => r.emailAddress?.address?.toLowerCase())
      .filter((a): a is string => Boolean(a)),
  };
}

/**
 * Fetches the full thread for a conversation across all folders (inbox + sent),
 * ordered oldest-first. Used for building conversation context (Phase 2).
 */
export async function fetchConversationThread(
  conversationId: string,
  limit = 50,
): Promise<GraphMessage[]> {
  const params: Record<string, string> = {
    $select: SELECT,
    $top: String(Math.min(limit, 50)),
    $filter: `conversationId eq '${conversationId}'`,
  };
  const res = await graphFetch(`${mailboxPath()}/messages?${odata(params)}`);
  const data = (await res.json()) as GraphListResponse<GraphMessage>;
  return [...data.value].sort(
    (a, b) =>
      new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
  );
}
