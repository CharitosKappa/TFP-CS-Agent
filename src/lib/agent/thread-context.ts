import { fetchConversationThread } from "../graph/messages";
import { makeIsInternal, toBodyText } from "../graph/message-parse";

export interface ThreadHistoryMessage {
  direction: "INBOUND" | "OUTBOUND";
  body: string;
}

/**
 * Builds the recent in-thread history for the agent straight from Graph (no DB),
 * mirroring what process.ts assembles from persisted messages: prior messages in
 * the same conversation, oldest→newest, excluding the current message and any
 * later ones, capped to `limit`. Used by flows that draft without ingesting into
 * the DB so replies are never blind to the conversation so far.
 */
export async function recentMessagesFromThread(
  conversationId: string,
  currentMessageId: string,
  currentReceivedAt: Date,
  limit = 6,
): Promise<ThreadHistoryMessage[]> {
  const thread = await fetchConversationThread(conversationId);
  const isInternal = makeIsInternal();
  return thread
    .filter(
      (m) =>
        m.id !== currentMessageId &&
        new Date(m.receivedDateTime) <= currentReceivedAt,
    )
    .map((m) => {
      const from = (m.from ?? m.sender)?.emailAddress?.address?.toLowerCase() ?? "";
      return {
        direction: isInternal(from) ? ("OUTBOUND" as const) : ("INBOUND" as const),
        body: toBodyText(m),
      };
    })
    .filter((m) => m.body.trim().length > 0)
    .slice(-limit);
}
