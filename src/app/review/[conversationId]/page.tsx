import Link from "next/link";
import { notFound } from "next/navigation";
import type { Classification } from "@/lib/agent/types";
import { getMessageAttachments, type GraphAttachment } from "@/lib/graph/messages";
import { getCustomerByEmail } from "@/lib/shopify/customers";
import { getOrderByName } from "@/lib/shopify/orders";
import { getAuditLog, getConversationForReview } from "@/lib/review/queue";
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
  reply_send_failed: "Αποτυχία αποστολής",
  reply_sent_persist_failed: "Αποστολή OK αλλά αποτυχία καταγραφής",
  reply_sent_reconciled: "Συμφιλίωση αποστολής",
};
const auditLabel = (a: string) => AUDIT_ACTION_LABELS[a] ?? a;

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}
const isImage = (ct: string) => ct.toLowerCase().startsWith("image/");
const fmtBytes = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const dataUri = (a: GraphAttachment) => `data:${a.contentType};base64,${a.contentBytes}`;

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

  const actionableDraft = conversation.drafts.find(
    (d) => d.status === "PENDING" || d.status === "APPROVED" || d.status === "EDITED",
  );
  const latestDraft = conversation.drafts[0];
  const draftToShow = actionableDraft ?? latestDraft;
  const classification = (draftToShow?.classification as Classification | null) ?? null;

  // Right-sidebar context, fetched live (best-effort — a failure just hides a card).
  const inbound = conversation.messages.filter((m) => m.direction === "INBOUND");
  const customer = conversation.customerEmail
    ? await safe(getCustomerByEmail(conversation.customerEmail))
    : null;
  const order = classification?.orderNumber
    ? await safe(getOrderByName(classification.orderNumber))
    : null;
  const attLists = await Promise.all(
    inbound.map((m) => safe(getMessageAttachments(m.graphMessageId))),
  );
  const attByMsg = new Map<string, GraphAttachment[]>();
  inbound.forEach((m, i) => {
    const a = (attLists[i] ?? []).filter((x) => x.contentBytes);
    if (a.length) attByMsg.set(m.id, a);
  });
  const attachments = [...attByMsg.values()].flat();

  return (
    <main className="detail">
      <Link href="/" className="backlink">
        ← Πίσω στην ουρά
      </Link>

      <div className="page-head">
        <h1>
          <span className="case-ref">#{conversation.ref}</span>{" "}
          {conversation.customerName ?? conversation.customerEmail}
        </h1>
        <span className="badge neutral">
          {CONVERSATION_STATUS_LABELS[conversation.status] ?? conversation.status}
        </span>
      </div>
      <p className="muted" style={{ marginTop: "-12px" }}>
        {conversation.subject ?? "(χωρίς θέμα)"} · {conversation.customerEmail}
      </p>

      <div className="detail-layout">
        {/* ── Left: thread + draft + audit ─────────────────────────── */}
        <div className="detail-main">
          <div className="card">
            <h2>Συνομιλία</h2>
            <div className="thread">
              {conversation.messages.map((m, i) => (
                <div
                  key={m.id}
                  className={`bubble ${m.direction === "INBOUND" ? "inbound" : "outbound"}`}
                >
                  <div className="bubble-head">
                    <span>
                      <span className="bubble-seq">#{i + 1}</span>{" "}
                      {m.direction === "INBOUND" ? "Πελάτης" : "TFP"} · {m.fromEmail}
                      {attByMsg.has(m.id) && (
                        <span className="muted"> · 📎 {attByMsg.get(m.id)!.length}</span>
                      )}
                    </span>
                    <span>{formatDateTime(m.receivedAt)}</span>
                  </div>
                  {m.bodyText}
                </div>
              ))}
            </div>
          </div>

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

                {draftToShow.status === "SENDING" && (
                  <div className="escalation-note">
                    ⚠ Έμεινε σε κατάσταση «αποστολή»: το email μπορεί να στάλθηκε αλλά δεν
                    καταγράφηκε. <strong>Μην ξαναστείλετε.</strong> Τρέξτε{" "}
                    <code>npm run reconcile</code>.
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
                    isEscalated={actionableDraft.isEscalated}
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
        </div>

        {/* ── Right: customer / order / media ──────────────────────── */}
        <aside className="detail-side">
          <div className="card side-card">
            <h3>Πελάτης</h3>
            <div className="kv">
              <span>Email</span>
              <b>{conversation.customerEmail}</b>
            </div>
            {customer ? (
              <>
                <div className="kv">
                  <span>Όνομα</span>
                  <b>{customer.name}</b>
                </div>
                <div className="kv">
                  <span>Παραγγελίες</span>
                  <b>{customer.numberOfOrders}</b>
                </div>
                <div className="kv">
                  <span>Σύνολο δαπανών</span>
                  <b>
                    {customer.amountSpent} {customer.currency}
                  </b>
                </div>
                {customer.recentOrders.length > 0 && (
                  <div className="kv-block">
                    <span>Πρόσφατες</span>
                    <ul>
                      {customer.recentOrders.map((o) => (
                        <li key={o.name}>
                          {o.name} · {o.createdAt.slice(0, 10)} · {o.fulfillmentStatus}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="muted side-empty">Δεν βρέθηκε στο Shopify με αυτό το email.</p>
            )}
          </div>

          {order && (
            <div className="card side-card">
              <h3>Παραγγελία {order.name}</h3>
              <div className="kv">
                <span>Κατάσταση</span>
                <b>
                  {order.fulfillmentStatus} / {order.financialStatus}
                </b>
              </div>
              <div className="kv">
                <span>Σύνολο</span>
                <b>
                  {order.total} {order.currency}
                </b>
              </div>
              {order.shippingCity && (
                <div className="kv">
                  <span>Αποστολή</span>
                  <b>{order.shippingCity}</b>
                </div>
              )}
              {order.lineItems.length > 0 && (
                <div className="kv-block">
                  <span>Προϊόντα</span>
                  <ul>
                    {order.lineItems.map((li, i) => (
                      <li key={i}>
                        {li.quantity}× {li.title}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {order.trackings.some((t) => t.number || t.url) && (
                <div className="kv-block">
                  <span>Tracking</span>
                  <ul>
                    {order.trackings
                      .filter((t) => t.number || t.url)
                      .map((t, i) => (
                        <li key={i}>{[t.company, t.number].filter(Boolean).join(" ")}</li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="card side-card">
            <h3>Media {attachments.length > 0 && `(${attachments.length})`}</h3>
            {attachments.length === 0 ? (
              <p className="muted side-empty">Κανένα συνημμένο.</p>
            ) : (
              <>
                <div className="media-grid">
                  {attachments
                    .filter((a) => isImage(a.contentType))
                    .map((a) => (
                      <a
                        key={a.id}
                        href={dataUri(a)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="media-thumb"
                        title={a.name}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={dataUri(a)} alt={a.name} />
                      </a>
                    ))}
                </div>
                {attachments
                  .filter((a) => !isImage(a.contentType))
                  .map((a) => (
                    <a key={a.id} href={dataUri(a)} download={a.name} className="media-file">
                      📄 {a.name} <span className="muted">{fmtBytes(a.size)}</span>
                    </a>
                  ))}
              </>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
