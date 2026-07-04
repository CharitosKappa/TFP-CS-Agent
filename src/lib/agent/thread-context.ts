import { fetchConversationThread, searchMessagesByParticipant } from "../graph/messages";
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
  const prior = thread
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
    });

  const withBody = prior.filter((m) => m.body.trim().length > 0).slice(-limit);

  // The repeat_after_reply escalation gate reads the LAST prior message's
  // direction, so it must be decided from the full chronological order — BEFORE
  // dropping empty-body messages. Otherwise an OUTBOUND reply whose body stripped
  // to empty (e.g. all quoted content) would vanish and a stale INBOUND would
  // look like "last", silently suppressing the escalation. Re-append the true
  // last message's direction (with a readable placeholder) when it was dropped.
  const last = prior[prior.length - 1];
  if (last && last.body.trim().length === 0) {
    withBody.push({
      direction: last.direction,
      body: last.direction === "OUTBOUND" ? "(η προηγούμενη απάντησή μας)" : "(προηγούμενο μήνυμα πελάτη)",
    });
  }
  return withBody;
}

/**
 * Summarises the customer's OTHER recent conversations (from Graph, no DB) so a
 * draft isn't blind to what we've already told them when they open a NEW email
 * instead of replying in-thread. Excludes the current conversation. Best-effort:
 * returns undefined on error or when there are no other threads.
 */
export async function relatedThreadsFromGraph(
  email: string,
  currentConversationId: string,
  opts: { maxThreads?: number; perThread?: number } = {},
): Promise<string | undefined> {
  const { maxThreads = 3, perThread = 4 } = opts;
  let msgs;
  try {
    msgs = await searchMessagesByParticipant(email);
  } catch {
    return undefined;
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!m.conversationId || m.conversationId === currentConversationId) continue;
    const arr = byConv.get(m.conversationId) ?? [];
    arr.push(m);
    byConv.set(m.conversationId, arr);
  }
  if (byConv.size === 0) return undefined;

  const isInternal = makeIsInternal();
  const blocks = [...byConv.values()].map((list) => {
    list.sort(
      (a, b) => new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
    );
    const latest = new Date(list[list.length - 1].receivedDateTime).getTime();
    const subject = list[list.length - 1].subject ?? "(χωρίς θέμα)";
    const lines = list
      .slice(-perThread)
      .map((m) => {
        const from = (m.from ?? m.sender)?.emailAddress?.address?.toLowerCase() ?? "";
        const who = isInternal(from) ? "Εμείς" : "Πελάτης";
        return `  [${who}] ${toBodyText(m).replace(/\s+/g, " ").slice(0, 300)}`;
      })
      .join("\n");
    return { latest, text: `Θέμα «${subject}»:\n${lines}` };
  });
  blocks.sort((a, b) => b.latest - a.latest);
  return blocks.slice(0, maxThreads).map((b) => b.text).join("\n\n");
}
