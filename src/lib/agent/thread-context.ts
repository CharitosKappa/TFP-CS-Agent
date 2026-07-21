import { DRAFTED_CATEGORY, fetchConversationThread, searchMessagesByParticipant } from "../graph/messages";
import { makeIsInternal, toBodyText } from "../graph/message-parse";
import { judgeSameRequest } from "./dedup";

export interface ThreadHistoryMessage {
  direction: "INBOUND" | "OUTBOUND";
  body: string;
}

/**
 * Builds the recent in-thread history for the agent straight from Graph (no DB):
 * prior messages in the same conversation, oldest→newest, excluding the current
 * message and any later ones, capped to `limit`. Lets a flow draft without
 * ingesting into a DB while never being blind to the conversation so far.
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
 * instead of replying in-thread. Excludes the current conversation and, for data
 * minimisation, anything older than `maxAgeDays` (so long-closed matters aren't
 * re-surfaced into an unrelated draft). Best-effort: returns undefined on error
 * or when there are no other recent threads.
 */
export async function relatedThreadsFromGraph(
  email: string,
  currentConversationId: string,
  opts: { maxThreads?: number; perThread?: number; maxAgeDays?: number } = {},
): Promise<string | undefined> {
  const { maxThreads = 3, perThread = 4, maxAgeDays = 180 } = opts;
  let msgs;
  try {
    msgs = await searchMessagesByParticipant(email);
  } catch {
    return undefined;
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!m.conversationId || m.conversationId === currentConversationId) continue;
    if (new Date(m.receivedDateTime).getTime() < cutoff) continue;
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

/**
 * Cross-thread duplicate check: has the SAME request from this customer ALREADY
 * been drafted in a DIFFERENT recent thread? The in-batch consolidation only
 * folds duplicates seen in the same run; when the customer re-sends the same
 * issue under a new subject and a LATER run picks it up, the earlier one is
 * already tagged handled and the new one would otherwise be drafted (and tasked)
 * again. Here we look at the customer's recent ALREADY-DRAFTED inbound messages
 * in other threads and, if the model is confident it's the same request, return
 * the match so the caller can fold this one instead of re-drafting.
 *
 * Best-effort/conservative: null on error, no candidates, or any doubt (via
 * judgeSameRequest). Bounded to recent, already-handled messages.
 */
export async function findHandledDuplicate(
  email: string,
  currentConversationId: string,
  current: { subject?: string; body: string },
  opts: { maxAgeDays?: number; maxCandidates?: number } = {},
): Promise<{ conversationId: string; subject?: string } | null> {
  const { maxAgeDays = 4, maxCandidates = 3 } = opts;
  if (!current.body.trim()) return null;
  let msgs;
  try {
    msgs = await searchMessagesByParticipant(email);
  } catch {
    return null;
  }
  const isInternal = makeIsInternal();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const candidates = msgs
    .filter((m) => m.conversationId && m.conversationId !== currentConversationId)
    .filter((m) => new Date(m.receivedDateTime).getTime() >= cutoff)
    .filter((m) => !isInternal((m.from ?? m.sender)?.emailAddress?.address?.toLowerCase() ?? "")) // customer's own
    .filter((m) => (m.categories ?? []).includes(DRAFTED_CATEGORY)) // already handled by a prior run
    .sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime())
    .slice(0, maxCandidates);
  for (const c of candidates) {
    const body = toBodyText(c);
    if (!body.trim()) continue;
    if (await judgeSameRequest([current, { subject: c.subject ?? undefined, body }])) {
      return { conversationId: c.conversationId, subject: c.subject ?? undefined };
    }
  }
  return null;
}
