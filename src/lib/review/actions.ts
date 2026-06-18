"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { processInboundMessage } from "@/lib/agent/process";
import { sendDraftReply } from "./send";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Who is recording the review. No auth layer yet (that lands in Phase 5), so the
 * reviewer identity comes from REVIEWER_EMAIL, falling back to the shared mailbox.
 */
function getReviewerEmail(): string {
  return (
    process.env.REVIEWER_EMAIL ||
    process.env.GRAPH_MAILBOX ||
    "reviewer@thefashionproject.gr"
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function revalidate(conversationId: string): void {
  revalidatePath("/");
  revalidatePath(`/review/${conversationId}`);
}

/**
 * Approves a PENDING draft (or records an EDIT if the reviewer changed the text)
 * and sends it in-thread. The review is committed first; if the send then fails,
 * the draft stays APPROVED/EDITED so it can be retried with `sendDraft`.
 */
export async function approveAndSendDraft(
  draftId: string,
  content: string,
  note?: string,
): Promise<ActionResult> {
  const reviewer = getReviewerEmail();
  let conversationId: string;

  try {
    conversationId = await prisma.$transaction(async (tx) => {
      const draft = await tx.draft.findUnique({ where: { id: draftId } });
      if (!draft) throw new Error("Το draft δεν βρέθηκε.");
      if (draft.status !== "PENDING") {
        throw new Error("Το draft έχει ήδη ελεγχθεί — ανανεώστε τη σελίδα.");
      }
      const trimmed = content.trim();
      if (!trimmed) throw new Error("Το κείμενο δεν μπορεί να είναι κενό.");

      const edited = trimmed !== draft.content.trim();
      const action = edited ? "EDIT" : "APPROVE";

      await tx.review.create({
        data: {
          draftId: draft.id,
          reviewerEmail: reviewer,
          action,
          editedContent: edited ? trimmed : null,
          note: note?.trim() || null,
        },
      });
      await tx.draft.update({
        where: { id: draft.id },
        data: {
          status: edited ? "EDITED" : "APPROVED",
          ...(edited ? { content: trimmed } : {}),
        },
      });

      const detail: Prisma.InputJsonValue = {
        reviewer,
        ...(note?.trim() ? { note: note.trim() } : {}),
        ...(edited ? { originalContent: draft.content } : {}),
      };
      await tx.auditLog.create({
        data: {
          conversationId: draft.conversationId,
          draftId: draft.id,
          actor: reviewer,
          action: `draft_${action.toLowerCase()}`,
          detail,
        },
      });

      return draft.conversationId;
    });
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }

  try {
    await sendDraftReply(draftId, reviewer);
  } catch (e) {
    revalidate(conversationId);
    return {
      ok: false,
      error: `Το draft εγκρίθηκε αλλά η αποστολή απέτυχε: ${errMsg(e)} — πατήστε «Αποστολή» για νέα προσπάθεια.`,
    };
  }

  revalidate(conversationId);
  return { ok: true };
}

/** Retries sending a draft already reviewed (APPROVED/EDITED) but not yet SENT. */
export async function sendDraft(draftId: string): Promise<ActionResult> {
  const reviewer = getReviewerEmail();
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { conversationId: true },
  });
  try {
    await sendDraftReply(draftId, reviewer);
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  if (draft) revalidate(draft.conversationId);
  return { ok: true };
}

/** Rejects a draft and hands the conversation to a human (ESCALATED). */
export async function rejectDraft(
  draftId: string,
  note?: string,
): Promise<ActionResult> {
  const reviewer = getReviewerEmail();
  try {
    const conversationId = await prisma.$transaction(async (tx) => {
      const draft = await tx.draft.findUnique({ where: { id: draftId } });
      if (!draft) throw new Error("Το draft δεν βρέθηκε.");
      if (draft.status !== "PENDING") {
        throw new Error("Το draft έχει ήδη ελεγχθεί — ανανεώστε τη σελίδα.");
      }
      await tx.review.create({
        data: {
          draftId: draft.id,
          reviewerEmail: reviewer,
          action: "REJECT",
          note: note?.trim() || null,
        },
      });
      await tx.draft.update({
        where: { id: draft.id },
        data: { status: "REJECTED" },
      });
      await tx.conversation.update({
        where: { id: draft.conversationId },
        data: { status: "ESCALATED" },
      });
      await tx.auditLog.create({
        data: {
          conversationId: draft.conversationId,
          draftId: draft.id,
          actor: reviewer,
          action: "draft_reject",
          detail: { reviewer, ...(note?.trim() ? { note: note.trim() } : {}) },
        },
      });
      return draft.conversationId;
    });
    revalidate(conversationId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/**
 * Feedback loop: rejects the current draft and regenerates a fresh one, feeding
 * the reviewer's note back into the prompt as correction guidance. The new draft
 * lands as PENDING for another review.
 */
export async function rejectAndRedraft(
  draftId: string,
  note: string,
): Promise<ActionResult> {
  const reviewer = getReviewerEmail();
  const guidance = note.trim();
  if (!guidance) {
    return { ok: false, error: "Γράψτε τι πρέπει να διορθώσει το νέο draft." };
  }

  let conversationId: string;
  let triggerMessageId: string;
  try {
    const res = await prisma.$transaction(async (tx) => {
      const draft = await tx.draft.findUnique({ where: { id: draftId } });
      if (!draft) throw new Error("Το draft δεν βρέθηκε.");
      if (draft.status !== "PENDING") {
        throw new Error("Το draft έχει ήδη ελεγχθεί — ανανεώστε τη σελίδα.");
      }
      if (!draft.triggerMessageId) {
        throw new Error("Λείπει το αρχικό μήνυμα — δεν γίνεται re-draft.");
      }
      await tx.review.create({
        data: {
          draftId: draft.id,
          reviewerEmail: reviewer,
          action: "REJECT",
          note: guidance,
        },
      });
      await tx.draft.update({
        where: { id: draft.id },
        data: { status: "REJECTED" },
      });
      await tx.auditLog.create({
        data: {
          conversationId: draft.conversationId,
          draftId: draft.id,
          actor: reviewer,
          action: "draft_reject",
          detail: { reviewer, note: guidance, redraft: true },
        },
      });
      return {
        conversationId: draft.conversationId,
        triggerMessageId: draft.triggerMessageId,
      };
    });
    conversationId = res.conversationId;
    triggerMessageId = res.triggerMessageId;
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }

  try {
    await processInboundMessage(triggerMessageId, {
      reviewerGuidance: guidance,
      updateSummary: false,
    });
    await prisma.auditLog.create({
      data: {
        conversationId,
        actor: reviewer,
        action: "draft_redraft",
        detail: { guidance },
      },
    });
  } catch (e) {
    revalidate(conversationId);
    return {
      ok: false,
      error: `Το draft απορρίφθηκε αλλά η αναδημιουργία απέτυχε: ${errMsg(e)}`,
    };
  }

  revalidate(conversationId);
  return { ok: true };
}
