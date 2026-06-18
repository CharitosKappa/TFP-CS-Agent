import Link from "next/link";
import { notFound } from "next/navigation";
import type { Classification } from "@/lib/agent/types";
import {
  getAuditLog,
  getConversationForReview,
} from "@/lib/review/queue";
import {
  CONVERSATION_STATUS_LABELS,
  DRAFT_STATUS_LABELS,
  REVIEW_ACTION_LABELS,
  formatDateTime,
  intentLabel,
  redLineLabel,
} from "@/lib/review/labels";
import DraftReviewPanel from "./DraftReviewPanel";

export const dynamic = "force-dynamic";

const AUDIT_ACTION_LABELS: Record<string, string> = {
  message_ingested: "Λήψη μηνύματος",
  draft_created: "Δημιουργία draft (agent)",
  draft_approve: "Έγκριση",
  draft_edit: "Επεξεργασία & έγκριση",
  draft_reject: "Απόρριψη",
  draft_redraft: "Αναδημιουργία draft (με οδηγία)",
  reply_sent: "Αποστολή απάντησης",
};

function auditLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const [conversation, audit] = await Promise.all([
    getConversationForReview(conversationId),
    getAuditLog(conversationId),
  ]);

  if (!conversation) notFound();

  // A draft the reviewer can still act on: never reviewed (PENDING) or approved
  // but not yet sent (a failed/pending send awaiting retry).
  const actionableDraft = conversation.drafts.find(
    (d) =>
      d.status === "PENDING" ||
      d.status === "APPROVED" ||
      d.status === "EDITED",
  );
  const latestDraft = conversation.drafts[0];
  const draftToShow = actionableDraft ?? latestDraft;
  const classification = (draftToShow?.classification as Classification | null) ?? null;

  return (
    <main>
      <Link href="/" className="backlink">
        ← Πίσω στην ουρά
      </Link>

      <div className="page-head">
        <h1>{conversation.customerName ?? conversation.customerEmail}</h1>
        <span className="badge neutral">
          {CONVERSATION_STATUS_LABELS[conversation.status] ?? conversation.status}
        </span>
      </div>
      <p className="muted" style={{ marginTop: "-12px" }}>
        {conversation.subject ?? "(χωρίς θέμα)"} · {conversation.customerEmail}
      </p>

      {/* ── Thread ──────────────────────────────────────────────── */}
      <div className="card">
        <h2>Συνομιλία</h2>
        <div className="thread">
          {conversation.messages.map((m) => (
            <div
              key={m.id}
              className={`bubble ${m.direction === "INBOUND" ? "inbound" : "outbound"}`}
            >
              <div className="bubble-head">
                <span>
                  {m.direction === "INBOUND" ? "Πελάτης" : "TFP"} · {m.fromEmail}
                </span>
                <span>{formatDateTime(m.receivedAt)}</span>
              </div>
              {m.bodyText}
            </div>
          ))}
        </div>
      </div>

      {/* ── Draft / review ──────────────────────────────────────── */}
      <div className="card">
        <h2>
          Draft απάντησης
          {draftToShow && (
            <span className="badge neutral" style={{ marginLeft: 10 }}>
              {DRAFT_STATUS_LABELS[draftToShow.status] ?? draftToShow.status}
            </span>
          )}
        </h2>

        {!draftToShow ? (
          <p className="muted">Δεν έχει δημιουργηθεί draft για αυτή τη συνομιλία.</p>
        ) : (
          <>
            <div className="draft-meta">
              {classification && (
                <span className="badge">{intentLabel(classification.intent)}</span>
              )}
              {classification && (
                <span className="badge neutral">
                  βεβαιότητα {Math.round(classification.confidence * 100)}%
                </span>
              )}
              {draftToShow.escalationReasons.map((r) => (
                <span key={r} className="badge warn">
                  {redLineLabel(r)}
                </span>
              ))}
            </div>

            {draftToShow.isEscalated && (
              <div className="escalation-note">
                ⚠ Κόκκινη γραμμή — απαιτεί ανθρώπινο χειρισμό. Ελέγξτε προσεκτικά πριν
                από οποιαδήποτε ενέργεια.
              </div>
            )}

            {draftToShow.reasoning && (
              <div className="reasoning">{draftToShow.reasoning}</div>
            )}

            {actionableDraft ? (
              <DraftReviewPanel
                draftId={actionableDraft.id}
                initialContent={actionableDraft.content}
                status={actionableDraft.status}
              />
            ) : (
              <>
                <label className="field-label">Κείμενο απάντησης</label>
                <div className="bubble outbound" style={{ maxWidth: "100%" }}>
                  {draftToShow.content}
                </div>
                {draftToShow.review && (
                  <p className="muted" style={{ marginTop: 12 }}>
                    {REVIEW_ACTION_LABELS[draftToShow.review.action] ??
                      draftToShow.review.action}{" "}
                    από {draftToShow.review.reviewerEmail} ·{" "}
                    {formatDateTime(draftToShow.review.createdAt)}
                    {draftToShow.review.note && ` — «${draftToShow.review.note}»`}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* ── Audit log ───────────────────────────────────────────── */}
      <div className="card">
        <h2>Ιστορικό ενεργειών</h2>
        {audit.length === 0 ? (
          <p className="muted">—</p>
        ) : (
          <ul className="audit">
            {audit.map((entry) => (
              <li key={entry.id}>
                <span className="when">{formatDateTime(entry.createdAt)}</span>
                <span>{auditLabel(entry.action)}</span>
                <span className="who">· {entry.actor}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
