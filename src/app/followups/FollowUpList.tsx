"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FollowUpItem } from "@/lib/review/queue";
import { markFollowUpHandled } from "@/lib/review/actions";
import { intentLabel, relativeTime } from "@/lib/review/labels";

export default function FollowUpList({
  items,
  nowMs,
}: {
  items: FollowUpItem[];
  nowMs: number;
}) {
  const router = useRouter();
  const now = new Date(nowMs);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handle(conversationId: string) {
    setError(null);
    setPendingId(conversationId);
    startTransition(async () => {
      const res = await markFollowUpHandled(conversationId);
      setPendingId(null);
      if (!res.ok) {
        setError(res.error ?? "Κάτι πήγε στραβά.");
      }
      router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="big">Καμία εκκρεμότητα ✦</div>
        <div>Δεν υπάρχουν ανοιχτές υποσχέσεις follow-up προς πελάτες.</div>
      </div>
    );
  }

  return (
    <>
      {error && <div className="action-error">{error}</div>}
      <div className="queue">
        {items.map((item) => (
          <div key={item.conversationId} className="queue-item">
            <div className="queue-item-top">
              <div className="queue-item-customer">
                <span className="case-ref">#{item.ref}</span>{" "}
                {item.customerName ?? item.customerEmail}
                {item.customerName && <span>{item.customerEmail}</span>}
              </div>
              <div className="queue-item-time" title="Υποσχεθήκαμε follow-up">
                υπόσχεση {relativeTime(new Date(item.since), now)}
              </div>
            </div>

            <div className="queue-item-subject">{item.subject ?? "(χωρίς θέμα)"}</div>
            {item.preview && <p className="queue-item-preview">{item.preview}…</p>}

            <div className="queue-item-meta">
              <span className="badge warn">Εκκρεμεί follow-up</span>
              {item.intent && <span className="badge">{intentLabel(item.intent)}</span>}
              {item.orderNumber && (
                <span className="badge neutral">παρ. #{item.orderNumber}</span>
              )}
            </div>

            <div className="actions" style={{ marginTop: 10 }}>
              <Link href={`/review/${item.conversationId}`} className="btn">
                Άνοιγμα
              </Link>
              <button
                type="button"
                className="btn primary"
                onClick={() => handle(item.conversationId)}
                disabled={pendingId === item.conversationId}
              >
                Διεκπεραιώθηκε
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
