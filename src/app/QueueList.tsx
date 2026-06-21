"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { QueueItem } from "@/lib/review/queue";
import {
  intentLabel,
  redLineLabel,
  relativeTime,
  sentimentBadgeClass,
  sentimentLabel,
} from "@/lib/review/labels";

const ts = (d: Date | string) => new Date(d).getTime();

export default function QueueList({
  items,
  nowMs,
}: {
  items: QueueItem[];
  nowMs: number;
}) {
  const [q, setQ] = useState("");
  const [intent, setIntent] = useState("all");
  const [esc, setEsc] = useState("all");
  const [sort, setSort] = useState("priority");
  const now = new Date(nowMs);

  const intents = useMemo(
    () => Array.from(new Set(items.map((i) => i.intent).filter(Boolean))) as string[],
    [items],
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    // filter() returns a fresh array, so sorting it in place is safe.
    const r = items.filter((i) => {
      if (intent !== "all" && i.intent !== intent) return false;
      if (esc === "escalated" && !i.isEscalated) return false;
      if (esc === "normal" && i.isEscalated) return false;
      if (term) {
        const hay =
          `#${i.ref} ${i.customerName ?? ""} ${i.customerEmail} ${i.subject ?? ""} ${i.preview}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    if (sort === "oldest") return r.sort((a, b) => ts(a.waitingSince) - ts(b.waitingSince));
    if (sort === "newest") return r.sort((a, b) => ts(b.waitingSince) - ts(a.waitingSince));
    if (sort === "confidence") return r.sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1));
    // "priority": items already arrive escalated-first / oldest-first from getReviewQueue.
    return r;
  }, [items, q, intent, esc, sort]);

  return (
    <>
      <div className="queue-controls">
        <input
          className="q-search"
          type="search"
          placeholder="Αναζήτηση: όνομα, email, #κωδικός, θέμα…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={intent} onChange={(e) => setIntent(e.target.value)}>
          <option value="all">Όλα τα intent</option>
          {intents.map((i) => (
            <option key={i} value={i}>
              {intentLabel(i)}
            </option>
          ))}
        </select>
        <select value={esc} onChange={(e) => setEsc(e.target.value)}>
          <option value="all">Όλα</option>
          <option value="escalated">Μόνο escalated</option>
          <option value="normal">Χωρίς escalation</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="priority">Ταξ.: Προτεραιότητα</option>
          <option value="oldest">Ταξ.: Παλαιότερα</option>
          <option value="newest">Ταξ.: Νεότερα</option>
          <option value="confidence">Ταξ.: Χαμηλή βεβαιότητα</option>
        </select>
        <span className="q-count">
          {filtered.length}/{items.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <div>Καμία αντιστοιχία στα φίλτρα.</div>
        </div>
      ) : (
        <div className="queue">
          {filtered.map((item) => (
            <Link
              key={item.draftId}
              href={`/review/${item.conversationId}`}
              className={`queue-item${item.isEscalated ? " escalated" : ""}`}
            >
              <div className="queue-item-top">
                <div className="queue-item-customer">
                  <span className="case-ref">#{item.ref}</span>{" "}
                  {item.customerName ?? item.customerEmail}
                  {item.customerName && <span>{item.customerEmail}</span>}
                </div>
                <div className="queue-item-time">
                  {relativeTime(new Date(item.waitingSince), now)}
                </div>
              </div>

              <div className="queue-item-subject">
                {item.hasImage && (
                  <span title="Περιέχει εικόνα" aria-label="Περιέχει εικόνα">
                    🖼️{" "}
                  </span>
                )}
                {item.subject ?? "(χωρίς θέμα)"}
              </div>
              {item.preview && <p className="queue-item-preview">{item.preview}…</p>}

              <div className="queue-item-meta">
                {item.draftStatus !== "PENDING" && (
                  <span className="badge warn">Προς αποστολή</span>
                )}
                {item.isEscalated && <span className="badge danger">Σε άνθρωπο</span>}
                <span className="badge">{intentLabel(item.intent)}</span>
                {item.sentiment && (
                  <span className={sentimentBadgeClass(item.sentiment)}>
                    {sentimentLabel(item.sentiment)}
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
    </>
  );
}
