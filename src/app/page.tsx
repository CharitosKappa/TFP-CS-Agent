import Link from "next/link";
import { getReviewQueue, getStuckSends } from "@/lib/review/queue";
import {
  intentLabel,
  redLineLabel,
  relativeTime,
} from "@/lib/review/labels";

export const dynamic = "force-dynamic";

function sentimentBadgeClass(sentiment: string | null): string {
  if (sentiment === "negative") return "badge danger";
  if (sentiment === "positive") return "badge ok";
  return "badge neutral";
}

export default async function QueuePage() {
  const [queue, stuck] = await Promise.all([getReviewQueue(), getStuckSends()]);
  const now = new Date();

  return (
    <main>
      <div className="page-head">
        <h1>Ουρά ελέγχου</h1>
        <span className="sub">
          {queue.length === 0
            ? "καμία εκκρεμότητα"
            : `${queue.length} draft προς έλεγχο`}
        </span>
      </div>

      {stuck.length > 0 && (
        <div className="escalation-note" style={{ marginBottom: 16 }}>
          ⚠ {stuck.length} draft σε κατάσταση «αποστολή» χρειάζονται έλεγχο (πιθανή
          μη ολοκληρωμένη καταγραφή αποστολής). Τρέξτε <code>npm run reconcile</code>{" "}
          ή ανοίξτε:{" "}
          {stuck.map((s, i) => (
            <span key={s.draftId}>
              {i > 0 && ", "}
              <Link href={`/review/${s.conversationId}`}>
                {s.customerEmail}
              </Link>
            </span>
          ))}
          .
        </div>
      )}

      {queue.length === 0 ? (
        <div className="empty">
          <div className="big">Όλα καθαρά ✦</div>
          <div>Δεν υπάρχουν drafts που να περιμένουν έλεγχο.</div>
        </div>
      ) : (
        <div className="queue">
          {queue.map((item) => (
            <Link
              key={item.draftId}
              href={`/review/${item.conversationId}`}
              className={`queue-item${item.isEscalated ? " escalated" : ""}`}
            >
              <div className="queue-item-top">
                <div className="queue-item-customer">
                  {item.customerName ?? item.customerEmail}
                  {item.customerName && <span>{item.customerEmail}</span>}
                </div>
                <div className="queue-item-time">
                  {relativeTime(item.waitingSince, now)}
                </div>
              </div>

              <div className="queue-item-subject">
                {item.subject ?? "(χωρίς θέμα)"}
              </div>
              {item.preview && (
                <p className="queue-item-preview">{item.preview}…</p>
              )}

              <div className="queue-item-meta">
                {item.draftStatus !== "PENDING" && (
                  <span className="badge warn">Προς αποστολή</span>
                )}
                {item.isEscalated && (
                  <span className="badge danger">Σε άνθρωπο</span>
                )}
                <span className="badge">{intentLabel(item.intent)}</span>
                {item.sentiment && (
                  <span className={sentimentBadgeClass(item.sentiment)}>
                    {item.sentiment === "negative"
                      ? "Αρνητικό"
                      : item.sentiment === "positive"
                        ? "Θετικό"
                        : "Ουδέτερο"}
                  </span>
                )}
                {item.confidence != null && (
                  <span className="badge neutral">
                    βεβαιότητα {Math.round(item.confidence * 100)}%
                  </span>
                )}
                {item.escalationReasons.map((r) => (
                  <span key={r} className="badge warn">
                    {redLineLabel(r)}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
