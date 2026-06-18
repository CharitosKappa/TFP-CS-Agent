"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

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

type Decision =
  | { action: "APPROVE"; note?: string }
  | { action: "EDIT"; editedContent: string; note?: string }
  | { action: "REJECT"; note?: string };

const DRAFT_STATUS: Record<Decision["action"], "APPROVED" | "EDITED" | "REJECTED"> = {
  APPROVE: "APPROVED",
  EDIT: "EDITED",
  REJECT: "REJECTED",
};

/**
 * Records a human decision on a draft as one atomic step:
 *   guard (draft must be PENDING) → Review → Draft.status (+content on edit)
 *   → Conversation.status → AuditLog.
 * Sending the approved reply is Phase 4 — approving here only marks it ready.
 */
async function recordDecision(
  draftId: string,
  decision: Decision,
): Promise<ActionResult> {
  const reviewer = getReviewerEmail();

  try {
    const conversationId = await prisma.$transaction(async (tx) => {
      const draft = await tx.draft.findUnique({ where: { id: draftId } });
      if (!draft) throw new Error("Το draft δεν βρέθηκε.");
      if (draft.status !== "PENDING") {
        throw new Error(
          "Το draft έχει ήδη ελεγχθεί από κάποιον — ανανεώστε τη σελίδα.",
        );
      }

      const editedContent =
        decision.action === "EDIT" ? decision.editedContent.trim() : null;
      if (decision.action === "EDIT" && !editedContent) {
        throw new Error("Το επεξεργασμένο κείμενο δεν μπορεί να είναι κενό.");
      }

      await tx.review.create({
        data: {
          draftId: draft.id,
          reviewerEmail: reviewer,
          action: decision.action,
          editedContent,
          note: decision.note?.trim() || null,
        },
      });

      await tx.draft.update({
        where: { id: draft.id },
        data: {
          status: DRAFT_STATUS[decision.action],
          // On edit the human's text becomes the canonical reply to send.
          ...(editedContent ? { content: editedContent } : {}),
        },
      });

      // Rejecting hands the conversation to a human; approve/edit keep it queued
      // for sending (Phase 4) and so leave the conversation status untouched.
      if (decision.action === "REJECT") {
        await tx.conversation.update({
          where: { id: draft.conversationId },
          data: { status: "ESCALATED" },
        });
      }

      const detail: Prisma.InputJsonValue = {
        reviewer,
        ...(decision.note ? { note: decision.note } : {}),
        ...(decision.action === "EDIT"
          ? { originalContent: draft.content }
          : {}),
      };

      await tx.auditLog.create({
        data: {
          conversationId: draft.conversationId,
          draftId: draft.id,
          actor: reviewer,
          action: `draft_${decision.action.toLowerCase()}`,
          detail,
        },
      });

      return draft.conversationId;
    });

    revalidatePath("/");
    revalidatePath(`/review/${conversationId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function approveDraft(
  draftId: string,
  note?: string,
): Promise<ActionResult> {
  return recordDecision(draftId, { action: "APPROVE", note });
}

export async function editAndApproveDraft(
  draftId: string,
  editedContent: string,
  note?: string,
): Promise<ActionResult> {
  return recordDecision(draftId, { action: "EDIT", editedContent, note });
}

export async function rejectDraft(
  draftId: string,
  note?: string,
): Promise<ActionResult> {
  return recordDecision(draftId, { action: "REJECT", note });
}
