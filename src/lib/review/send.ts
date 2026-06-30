// Sends an approved draft as an in-thread reply and records the outbound turn.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { sendReplyInThread, type OutgoingAttachment } from "@/lib/graph/messages";
import { textToHtml } from "@/lib/ingestion/html";
import { updateCaseSummary } from "@/lib/agent/summary";
import { fetchOdooAttachment } from "@/lib/odoo/attachments";
import { errInfo, log } from "@/lib/observability/logger";

/**
 * Sends a reviewed draft (APPROVED or EDITED) to the customer in the original
 * thread, with integrity guarantees:
 *
 *  1. Escalation gate — a red-line draft can only be sent with an override reason.
 *  2. Atomic claim (-> SENDING) before the Graph send, so two reviewers acting at
 *     once can never send the same draft twice.
 *  3. The send outcome is persisted in its own transaction BEFORE the rolling
 *     summary is updated, so a summary failure can never lose the SENT record or
 *     allow a re-send. The summary update is best-effort.
 *
 * Failure handling: a failed send releases the claim (retryable) and is audited;
 * a send that succeeds but fails to persist is left in SENDING (NOT retryable)
 * and alerted, so we never double-email a customer.
 */
export async function sendDraftReply(
  draftId: string,
  actor: string,
  overrideReason?: string,
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

  const override = overrideReason?.trim() || "";
  if (draft.isEscalated && !override) {
    throw new Error(
      "Το draft είναι escalated (κόκκινη γραμμή) — απαιτείται αιτιολόγηση override για αποστολή.",
    );
  }

  // Resolve the return voucher (if this reply promised one) BEFORE claiming the
  // draft, so a fetch failure aborts cleanly — we must never email a reply that
  // says "attached is your voucher" without the actual attachment.
  const voucherId = (draft.classification as unknown as { voucherAttachmentId?: number } | null)
    ?.voucherAttachmentId;
  let attachments: OutgoingAttachment[] = [];
  if (typeof voucherId === "number") {
    let att;
    try {
      att = await fetchOdooAttachment(voucherId);
    } catch (e) {
      log.error("voucher_fetch_failed", { draftId, voucherId, ...errInfo(e) });
      throw new Error("Αποτυχία ανάκτησης του voucher επιστροφής — η αποστολή ακυρώθηκε, δοκιμάστε ξανά.");
    }
    if (!att) {
      log.error("voucher_fetch_empty", { draftId, voucherId });
      throw new Error("Το voucher επιστροφής δεν βρέθηκε στο Odoo — η αποστολή ακυρώθηκε.");
    }
    attachments = [{ name: att.name, contentType: att.mimetype, base64: att.base64 }];
  }

  const priorStatus = draft.status; // APPROVED | EDITED — restored if the send fails.

  // Atomic claim: only one caller can move APPROVED/EDITED -> SENDING.
  const claim = await prisma.draft.updateMany({
    where: { id: draftId, status: { in: ["APPROVED", "EDITED"] } },
    data: { status: "SENDING" },
  });
  if (claim.count === 0) {
    throw new Error("Το draft στέλνεται ήδη ή έχει σταλεί — ανανεώστε τη σελίδα.");
  }

  const mailbox = getEnv().GRAPH_MAILBOX.toLowerCase();
  const bodyHtml = textToHtml(draft.content);

  // 1. Send via Graph.
  let sent;
  try {
    sent = await sendReplyInThread(draft.triggerMessage.graphMessageId, bodyHtml, attachments);
  } catch (e) {
    await prisma.draft
      .update({ where: { id: draftId }, data: { status: priorStatus } })
      .catch(() => {});
    await prisma.auditLog
      .create({
        data: {
          conversationId: draft.conversationId,
          draftId,
          actor,
          action: "reply_send_failed",
          detail: { error: errInfo(e).message },
        },
      })
      .catch(() => {});
    log.error("reply_send_failed", { draftId, ...errInfo(e) });
    throw new Error("Η αποστολή απέτυχε — δοκιμάστε ξανά.");
  }

  // 2. Persist the outcome (independent of the summary).
  const detail: Prisma.InputJsonValue = {
    graphMessageId: sent.graphMessageId,
    to: sent.toEmails,
    ...(override ? { escalationOverride: override } : {}),
    ...(attachments.length ? { voucherAttached: voucherId } : {}),
  };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          conversationId: draft.conversationId,
          graphMessageId: sent.graphMessageId,
          internetMessageId: sent.internetMessageId,
          direction: "OUTBOUND",
          fromEmail: mailbox,
          toEmails: sent.toEmails.length
            ? sent.toEmails
            : [draft.conversation.customerEmail],
          bodyText: draft.content,
          receivedAt: new Date(),
        },
      });
      await tx.draft.update({ where: { id: draftId }, data: { status: "SENT" } });
      await tx.conversation.update({
        where: { id: draft.conversationId },
        // A holding reply (promised follow-up from us) keeps the ball in OUR
        // court → AWAITING_FOLLOWUP. A self-contained reply waits on the customer.
        data: {
          status: draft.promisesFollowUp ? "AWAITING_FOLLOWUP" : "AWAITING_CUSTOMER",
        },
      });
      await tx.auditLog.create({
        data: {
          conversationId: draft.conversationId,
          draftId,
          actor,
          action: "reply_sent",
          detail,
        },
      });
    });
  } catch (e) {
    // Email went out but recording failed. Leave the draft in SENDING (not
    // sendable) so it can never be re-sent; alert for manual reconciliation.
    log.error("reply_sent_persist_failed", {
      draftId,
      graphMessageId: sent.graphMessageId,
      ...errInfo(e),
    });
    await prisma.auditLog
      .create({
        data: {
          conversationId: draft.conversationId,
          draftId,
          actor,
          action: "reply_sent_persist_failed",
          detail: { graphMessageId: sent.graphMessageId },
        },
      })
      .catch(() => {});
    throw new Error(
      "Το email στάλθηκε αλλά απέτυχε η καταγραφή — χρειάζεται έλεγχος (δεν θα ξανασταλεί αυτόματα).",
    );
  }

  // 3. Best-effort rolling-summary update (must not affect the recorded send).
  try {
    const newSummary = await updateCaseSummary(draft.conversation.summary ?? "", {
      direction: "OUTBOUND",
      body: draft.content,
    });
    await prisma.conversation.update({
      where: { id: draft.conversationId },
      data: { summary: newSummary },
    });
  } catch (e) {
    log.warn("summary_update_failed_after_send", { draftId, ...errInfo(e) });
  }

  log.info("reply_sent", { draftId, conversationId: draft.conversationId, escalated: draft.isEscalated });
}
