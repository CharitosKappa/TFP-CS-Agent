import Link from "next/link";
import { getOpenFollowUps, getReviewQueue, getStuckSends } from "@/lib/review/queue";
import FollowUpList from "./followups/FollowUpList";
import QueueList from "./QueueList";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const [queue, stuck, followUps] = await Promise.all([
    getReviewQueue(),
    getStuckSends(),
    getOpenFollowUps(),
  ]);

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

      {followUps.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <div className="page-head" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Ανοιχτές εκκρεμότητες (follow-up)</h2>
            <Link href="/followups" className="sub">
              {followUps.length} προς διεκπεραίωση →
            </Link>
          </div>
          <FollowUpList items={followUps} nowMs={Date.now()} />
        </section>
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
