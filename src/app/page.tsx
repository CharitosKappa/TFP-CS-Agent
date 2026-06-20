import Link from "next/link";
import { getReviewQueue, getStuckSends } from "@/lib/review/queue";
import QueueList from "./QueueList";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const [queue, stuck] = await Promise.all([getReviewQueue(), getStuckSends()]);

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
                #{s.ref} {s.customerEmail}
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
        <QueueList items={queue} nowMs={Date.now()} />
      )}
    </main>
  );
}
