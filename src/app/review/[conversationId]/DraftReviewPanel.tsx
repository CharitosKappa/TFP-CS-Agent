"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveDraft,
  editAndApproveDraft,
  rejectDraft,
  type ActionResult,
} from "@/lib/review/actions";

interface Props {
  draftId: string;
  initialContent: string;
}

export default function DraftReviewPanel({ draftId, initialContent }: Props) {
  const router = useRouter();
  const [content, setContent] = useState(initialContent);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const edited = content.trim() !== initialContent.trim();

  function run(fn: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "Κάτι πήγε στραβά.");
        return;
      }
      router.push("/");
      router.refresh();
    });
  }

  function onApprove() {
    const trimmedNote = note.trim() || undefined;
    if (edited) {
      run(() => editAndApproveDraft(draftId, content, trimmedNote));
    } else {
      run(() => approveDraft(draftId, trimmedNote));
    }
  }

  function onReject() {
    run(() => rejectDraft(draftId, note.trim() || undefined));
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
        Σημείωση ελεγκτή (προαιρετικό)
      </label>
      <input
        id="note"
        className="note"
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="π.χ. λόγος απόρριψης ή τι άλλαξα"
        disabled={pending}
      />

      <div className="actions">
        <button
          type="button"
          className="btn primary"
          onClick={onApprove}
          disabled={pending || content.trim().length === 0}
        >
          {edited ? "Αποθήκευση & έγκριση" : "Έγκριση"}
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={onReject}
          disabled={pending}
        >
          Απόρριψη
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
