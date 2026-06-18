"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveAndSendDraft,
  rejectAndRedraft,
  rejectDraft,
  sendDraft,
  type ActionResult,
} from "@/lib/review/actions";

interface Props {
  draftId: string;
  initialContent: string;
  /** PENDING → full review UI; APPROVED/EDITED → unsent, show retry-send. */
  status: string;
}

export default function DraftReviewPanel({
  draftId,
  initialContent,
  status,
}: Props) {
  const router = useRouter();
  const [content, setContent] = useState(initialContent);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const edited = content.trim() !== initialContent.trim();

  function run(fn: () => Promise<ActionResult>, stay = false) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "Κάτι πήγε στραβά.");
        if (stay) router.refresh();
        return;
      }
      router.push("/");
      router.refresh();
    });
  }

  // Approved but not yet sent (e.g. a send that failed): offer a retry.
  if (status !== "PENDING") {
    return (
      <div>
        <div className="escalation-note" style={{ background: "var(--warn-soft)", borderColor: "var(--warn)", color: "var(--warn)" }}>
          ⏳ Εγκεκριμένο αλλά δεν έχει σταλεί ακόμη.
        </div>
        <div className="bubble outbound" style={{ maxWidth: "100%" }}>
          {initialContent}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => run(() => sendDraft(draftId), true)}
            disabled={pending}
          >
            Αποστολή
          </button>
        </div>
        {error && <div className="action-error">{error}</div>}
      </div>
    );
  }

  return (
    <div>
      <label className="field-label" htmlFor="editor">
        Κείμενο απάντησης {edited && <em>(τροποποιημένο)</em>}
      </label>
      <textarea
        id="editor"
        className="editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={pending}
      />

      <label className="field-label" htmlFor="note">
        Σημείωση ελεγκτή (υποχρεωτική για «ξαναγράψε»)
      </label>
      <input
        id="note"
        className="note"
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="π.χ. «μην υπόσχεσαι δωρεάν επιστροφή» ή λόγος απόρριψης"
        disabled={pending}
      />

      <div className="actions">
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            run(() => approveAndSendDraft(draftId, content, note.trim() || undefined))
          }
          disabled={pending || content.trim().length === 0}
        >
          {edited ? "Αποθήκευση & αποστολή" : "Έγκριση & αποστολή"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => run(() => rejectAndRedraft(draftId, note))}
          disabled={pending || note.trim().length === 0}
          title={
            note.trim().length === 0
              ? "Γράψτε σημείωση με την οδηγία διόρθωσης"
              : undefined
          }
        >
          Απόρριψη & ξαναγράψε
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => run(() => rejectDraft(draftId, note.trim() || undefined))}
          disabled={pending}
        >
          Απόρριψη (σε άνθρωπο)
        </button>
        {edited && (
          <button
            type="button"
            className="btn"
            onClick={() => setContent(initialContent)}
            disabled={pending}
          >
            Επαναφορά
          </button>
        )}
      </div>

      {error && <div className="action-error">{error}</div>}
    </div>
  );
}
