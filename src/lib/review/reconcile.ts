// Recovery for drafts stuck in SENDING (a send that wasn't fully persisted).
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/observability/logger";

export interface ReconcileResult {
  count: number;
  dryRun: boolean;
  results: {
    draftId: string;
    action: "backfilled" | "reverted_to_approved" | "skipped";
    graphMessageId?: string;
  }[];
}

/**
 * Resolves every draft stuck in SENDING older than `olderThanMinutes`:
 *  - if a `reply_sent_persist_failed` audit exists, the email WAS sent → back-fill
 *    the OUTBOUND message + SENT + AWAITING_CUSTOMER (idempotent via upsert);
 *  - otherwise the send never completed → revert to APPROVED so it can be retried.
 */
export async function reconcileStuckSends(
  opts: { olderThanMinutes?: number; dryRun?: boolean } = {},
): Promise<ReconcileResult> {
  const cutoff = new Date(Date.now() - (opts.olderThanMinutes ?? 5) * 60_000);
  const stuck = await prisma.draft.findMany({
    where: { status: "SENDING", updatedAt: { lt: cutoff } },
    include: { conversation: true },
  });

  const results: ReconcileResult["results"] = [];
  for (const draft of stuck) {
    const sentAudit = await prisma.auditLog.findFirst({
      where: { draftId: draft.id, action: "reply_sent_persist_failed" },
      orderBy: { createdAt: "desc" },
    });
    const graphMessageId = (sentAudit?.detail as { graphMessageId?: string } | null)
      ?.graphMessageId;

    if (sentAudit && graphMessageId) {
      if (!opts.dryRun) {
        await backfillSent(
          draft.id,
          draft.conversationId,
          draft.conversation.customerEmail,
          draft.content,
          graphMessageId,
        );
      }
      results.push({ draftId: draft.id, action: "backfilled", graphMessageId });
    } else if (sentAudit) {
      // Sent, but the id wasn't recorded — needs a human; don't guess.
      results.push({ draftId: draft.id, action: "skipped" });
    } else {
      // No evidence the email went out → safe to make it retryable again.
      if (!opts.dryRun) {
        await prisma.draft.update({
          where: { id: draft.id },
          data: { status: "APPROVED" },
        });
      }
      results.push({ draftId: draft.id, action: "reverted_to_approved" });
    }
  }

  log.info("reconcile_stuck_sends", { count: stuck.length, dryRun: !!opts.dryRun });
  return { count: stuck.length, dryRun: !!opts.dryRun, results };
}

async function backfillSent(
  draftId: string,
  conversationId: string,
  customerEmail: string,
  content: string,
  graphMessageId: string,
): Promise<void> {
  const mailbox = getEnv().GRAPH_MAILBOX.toLowerCase();
  await prisma.$transaction(async (tx) => {
    await tx.message.upsert({
      where: { graphMessageId },
      create: {
        conversationId,
        graphMessageId,
        direction: "OUTBOUND",
        fromEmail: mailbox,
        toEmails: [customerEmail],
        bodyText: content,
        receivedAt: new Date(),
      },
      update: {},
    });
    await tx.draft.update({ where: { id: draftId }, data: { status: "SENT" } });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { status: "AWAITING_CUSTOMER" },
    });
    await tx.auditLog.create({
      data: {
        conversationId,
        draftId,
        actor: "reconcile",
        action: "reply_sent_reconciled",
        detail: { graphMessageId },
      },
    });
  });
}
