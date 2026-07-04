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
  "replyTo",
  "body",
  "bodyPreview",
  "receivedDateTime",
  "isRead",
  "internetMessageId",
  "categories",
].join(",");

/**
 * Category set on a CUSTOMER message once the agent has drafted a reply for it.
 * The idempotency guard for repeating runs: the drafter skips any unread message
 * already carrying this tag, so it never double-drafts the same message.
 */
export const DRAFTED_CATEGORY = "TFP: Drafted";

/** Category set on every AI-generated draft so a reviewer can tell at a glance. */
export const AI_CATEGORY = "Ai";

function mailboxPath(): string {
  return `/users/${encodeURIComponent(getEnv().GRAPH_MAILBOX)}`;
}

/** Builds an OData query string: keys literal, values percent-encoded. */
function odata(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * Follows `@odata.nextLink` from a first request, accumulating messages until
 * `limit` is reached or the pages run out. Graph caps `$top` at 50, so anything
 * past the first page needs this loop — without it, history is silently
 * truncated to one page.
 */
async function pageMessages(firstRel: string, limit: number): Promise<GraphMessage[]> {
  let next: string | null = firstRel;
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

/** Fetches recent messages from a mail folder (newest first), paging up to `limit`. */
async function fetchFolderMessages(
  folder: string,
  opts: { limit?: number; since?: Date; unreadOnly?: boolean; excludeCategory?: string } = {},
): Promise<GraphMessage[]> {
  const limit = opts.limit ?? 25;
  const params: Record<string, string> = {
    $select: SELECT,
    $top: String(Math.min(limit, 50)),
    $orderby: "receivedDateTime desc",
  };
  const filters: string[] = [];
  if (opts.since) filters.push(`receivedDateTime ge ${opts.since.toISOString()}`);
  if (opts.unreadOnly) filters.push("isRead eq false");
  // Exclude messages already carrying a tag (e.g. "TFP: Drafted") so a repeating
  // run always fetches FRESH work — the newest-N window never fills up with
  // already-drafted items, so a backlog drains instead of stalling.
  if (opts.excludeCategory) {
    filters.push(`not categories/any(c:c eq '${opts.excludeCategory.replace(/'/g, "''")}')`);
  }
  if (filters.length) params.$filter = filters.join(" and ");

  return pageMessages(`${mailboxPath()}/mailFolders/${folder}/messages?${odata(params)}`, limit);
}

/** Recent inbox messages (customer → us), newest first. Pass unreadOnly to filter. */
export function fetchInboxMessages(
  opts: { limit?: number; since?: Date; unreadOnly?: boolean; excludeCategory?: string } = {},
) {
  return fetchFolderMessages("inbox", opts);
}

/**
 * Finds messages involving a given customer across ALL folders and threads
 * (from OR to them), via mailbox search. Used to surface a customer's OTHER
 * conversations — customers often open a new email instead of replying in the
 * existing thread, so per-conversation history alone misses the prior exchange.
 */
export async function searchMessagesByParticipant(
  email: string,
  limit = 100,
): Promise<GraphMessage[]> {
  // KQL mail search. $search can't combine with $orderby, so the caller sorts in
  // code — which means we must page past the first 50 results, or a busy
  // customer's most recent other-thread is silently missed.
  const params = odata({
    $search: `"participants:${email}"`,
    $select: SELECT,
    $top: "50",
  });
  return pageMessages(`${mailboxPath()}/messages?${params}`, limit);
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

export interface SentReply {
  /**
   * Id of the reply message (the Drafts copy that was sent). It differs from the
   * eventual Sent Items id; this is fine because we only ingest the INBOX, so a
   * self-sent reply is never re-ingested. If Sent Items ingestion is ever added,
   * dedupe OUTBOUND on internetMessageId instead of this id.
   */
  graphMessageId: string;
  conversationId: string;
  toEmails: string[];
  /** RFC Message-ID — stable across folders, so Sent Items ingestion can dedupe this reply. */
  internetMessageId: string | null;
}

/** A file to attach to an outgoing reply (small files only — sent inline as base64). */
export interface OutgoingAttachment {
  name: string;
  contentType: string;
  /** base64-encoded file bytes. */
  base64: string;
}

// These calls are non-idempotent — never auto-retry them, or a lost-response
// timeout/5xx could double-send the email or orphan reply drafts.
const NO_RETRY = { retries: 0 } as const;

/**
 * Creates an in-thread reply DRAFT (not sent): createReply (preserves RE:
 * subject, In-Reply-To/References, conversationId) → set our body → add
 * attachments. Returns the draft GraphMessage. Attachments are inline
 * fileAttachments, which Graph supports up to ~3 MB per file (fine for a voucher).
 */
interface ReplyDraftOptions {
  attachments?: OutgoingAttachment[];
  /** Outlook categories (tags) to set on the draft, e.g. for escalation. */
  categories?: string[];
  /** Flag the draft for follow-up and mark it high importance. */
  flagged?: boolean;
}

async function buildReplyDraft(
  originalGraphMessageId: string,
  bodyHtml: string,
  opts: ReplyDraftOptions = {},
): Promise<GraphMessage> {
  const { attachments = [], categories, flagged } = opts;
  const id = encodeURIComponent(originalGraphMessageId);
  const created = await graphFetch(
    `${mailboxPath()}/messages/${id}/createReply`,
    { method: "POST" },
    NO_RETRY,
  );
  const draft = (await created.json()) as GraphMessage;
  const draftId = encodeURIComponent(draft.id);

  // createReply pre-fills the draft body with the quoted thread (RE: history),
  // but its POST response doesn't include that body — fetch it, then prepend our
  // reply ABOVE it (rather than replacing the body) so the email shows the full
  // conversation like a normal reply.
  const composed = await graphFetch(
    `${mailboxPath()}/messages/${draftId}?${odata({ $select: "body" })}`,
    {},
    NO_RETRY,
  );
  const quoted = ((await composed.json()) as GraphMessage).body?.content ?? "";
  const content = quoted ? `${bodyHtml}<br>${quoted}` : bodyHtml;

  await graphFetch(
    `${mailboxPath()}/messages/${draftId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        body: { contentType: "HTML", content },
        ...(categories?.length ? { categories } : {}),
        ...(flagged ? { flag: { flagStatus: "flagged" }, importance: "high" } : {}),
      }),
    },
    NO_RETRY,
  );

  for (const att of attachments) {
    await graphFetch(
      `${mailboxPath()}/messages/${draftId}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: att.name,
          contentType: att.contentType,
          contentBytes: att.base64,
        }),
      },
      NO_RETRY,
    );
  }
  return draft;
}

/**
 * Creates a reply draft in the original thread and leaves it UNSENT in the
 * mailbox's Drafts folder for a human to review and send from Outlook.
 */
export async function createReplyDraft(
  originalGraphMessageId: string,
  bodyHtml: string,
  opts: ReplyDraftOptions = {},
): Promise<{ graphMessageId: string; webLink?: string | null }> {
  const id = encodeURIComponent(originalGraphMessageId);
  // createReply marks the source message as READ. For a draft (unsent) we don't
  // want to silently change the customer message's state — capture it and restore
  // unread afterwards so the reviewer still sees it as unread.
  const before = await graphFetch(`${mailboxPath()}/messages/${id}?${odata({ $select: "isRead" })}`);
  const wasUnread = ((await before.json()) as { isRead?: boolean }).isRead === false;

  const draft = await buildReplyDraft(originalGraphMessageId, bodyHtml, opts);

  if (wasUnread) {
    await graphFetch(
      `${mailboxPath()}/messages/${id}`,
      { method: "PATCH", body: JSON.stringify({ isRead: false }) },
      NO_RETRY,
    );
  }
  return { graphMessageId: draft.id, webLink: draft.webLink ?? null };
}

/**
 * Creates a brand-new reply DRAFT addressed to `to` (a fresh message, not an
 * in-thread reply), left UNSENT in Drafts. Used for Shopify contact-form mail,
 * where the inbound arrives from mailer@shopify.com but the reply must go to the
 * real customer — so replying in-thread would wrongly answer the Shopify mailer.
 */
export async function createNewDraft(opts: {
  to: string;
  subject: string;
  bodyHtml: string;
  categories?: string[];
  flagged?: boolean;
}): Promise<{ graphMessageId: string; webLink?: string | null }> {
  const res = await graphFetch(
    `${mailboxPath()}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        subject: opts.subject,
        body: { contentType: "HTML", content: opts.bodyHtml },
        toRecipients: [{ emailAddress: { address: opts.to } }],
        ...(opts.categories?.length ? { categories: opts.categories } : {}),
        ...(opts.flagged ? { flag: { flagStatus: "flagged" }, importance: "high" } : {}),
      }),
    },
    NO_RETRY,
  );
  const draft = (await res.json()) as GraphMessage;
  return { graphMessageId: draft.id, webLink: draft.webLink ?? null };
}

/**
 * Flags and/or tags an existing message in Outlook (e.g. the customer's inbound
 * message), so the conversation stands out in the inbox. `categories` are
 * Outlook's colour tags; `flagged` sets a follow-up flag. Does not affect the
 * message's read state.
 */
export async function flagMessage(
  graphMessageId: string,
  opts: { categories?: string[]; flagged?: boolean } = {},
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (opts.categories?.length) patch.categories = opts.categories;
  if (opts.flagged) patch.flag = { flagStatus: "flagged" };
  if (Object.keys(patch).length === 0) return;
  await graphFetch(
    `${mailboxPath()}/messages/${encodeURIComponent(graphMessageId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    NO_RETRY,
  );
}

/**
 * Sends a reply in the original thread: build the reply draft (body +
 * attachments) → send. Replies go to the sender of the original (the customer).
 */
export async function sendReplyInThread(
  originalGraphMessageId: string,
  bodyHtml: string,
  attachments: OutgoingAttachment[] = [],
): Promise<SentReply> {
  const draft = await buildReplyDraft(originalGraphMessageId, bodyHtml, { attachments });
  // Send. Returns 202 Accepted with no body.
  await graphFetch(
    `${mailboxPath()}/messages/${encodeURIComponent(draft.id)}/send`,
    { method: "POST" },
    NO_RETRY,
  );

  return {
    graphMessageId: draft.id,
    conversationId: draft.conversationId,
    // Assigned at draft creation and preserved through send, so it matches the
    // Sent Items copy — lets ingestion dedupe instead of double-recording.
    internetMessageId: draft.internetMessageId ?? null,
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
  limit = 250,
): Promise<GraphMessage[]> {
  const params: Record<string, string> = {
    $select: SELECT,
    $top: "50",
    $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
  };
  // Page the whole thread (Graph's default order for a $filter isn't guaranteed
  // chronological, and one page caps at 50), then sort oldest-first in memory so
  // a caller slicing the newest N actually gets the latest messages.
  const all = await pageMessages(`${mailboxPath()}/messages?${odata(params)}`, limit);
  return all.sort(
    (a, b) =>
      new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
  );
}
