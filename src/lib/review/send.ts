// Sends an approved draft as an in-thread reply and records the outbound turn.
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { sendReplyInThread } from "@/lib/graph/messages";
import { textToHtml } from "@/lib/ingestion/html";
import { updateCaseSummary } from "@/lib/agent/summary";

/**
 * Sends a reviewed draft (status APPROVED or EDITED) to the customer in the
 * original thread, then atomically: records the OUTBOUND message → marks the
 * draft SENT → moves the conversation to AWAITING_CUSTOMER → folds the reply
 * into the rolling summary (so follow-ups keep full context) → audit log.
 *
 * The Graph send happens BEFORE the transaction: if it fails, nothing in the DB
 * changes and the draft stays APPROVED/EDITED for a retry.
 */
export async function sendDraftReply(
  draftId: string,
  actor: string,
): Promise<void> {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { conversation: true, triggerMessage: true },
  });
  if (!draft) throw new Error("Το draft δεν βρέθηκε.");
  if (draft.status === "SENT") throw new Error("Το draft έχει ήδη σταλεί.");
  if (draft.status !== "APPROVED" && draft.status !== "EDITED") {
    throw new Error("Μόνο εγκεκριμένο draft μπορεί να σταλεί.");
  }
  if (!draft.triggerMessage) {
    throw new Error("Λείπει το αρχικό μήνυμα — αδύνατη η απάντηση στο thread.");
  }

  const mailbox = getEnv().GRAPH_MAILBOX.toLowerCase();
  const bodyHtml = textToHtml(draft.content);

  // 1. Send via Graph (outside the transaction — network call).
  const sent = await sendReplyInThread(draft.triggerMessage.graphMessageId, bodyHtml);

  // 2. Fold our reply into the rolling summary (Anthropic call, also pre-tx).
  const newSummary = await updateCaseSummary(draft.conversation.summary ?? "", {
    direction: "OUTBOUND",
    body: draft.content,
  });

  // 3. Persist everything atomically.
  await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        conversationId: draft.conversationId,
        graphMessageId: sent.graphMessageId,
        direction: "OUTBOUND",
        fromEmail: mailbox,
        toEmails: sent.toEmails.length
          ? sent.toEmails
          : [draft.conversation.customerEmail],
        bodyText: draft.content,
        bodyHtml,
        receivedAt: new Date(),
      },
    });
    await tx.draft.update({
      where: { id: draft.id },
      data: { status: "SENT" },
    });
    await tx.conversation.update({
      where: { id: draft.conversationId },
      data: { status: "AWAITING_CUSTOMER", summary: newSummary },
    });
    await tx.auditLog.create({
      data: {
        conversationId: draft.conversationId,
        draftId: draft.id,
        actor,
        action: "reply_sent",
        detail: { graphMessageId: sent.graphMessageId, to: sent.toEmails },
      },
    });
  });
}
