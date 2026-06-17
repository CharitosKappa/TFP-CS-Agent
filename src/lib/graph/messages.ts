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
