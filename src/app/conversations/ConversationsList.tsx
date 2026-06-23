"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ConversationListItem } from "@/lib/review/queue";
import {
  conversationStatusBadgeClass,
  conversationStatusLabel,
  DRAFT_STATUS_LABELS,
  intentLabel,
  relativeTime,
} from "@/lib/review/labels";

const ts = (d: Date | string) => new Date(d).getTime();

// Tag for threads we started that have no customer message yet.
const OUTBOUND_ONLY_LABEL = "Δική μας έναρξη";

// Stable, meaningful order for the status filter (only those actually present
// are shown).
const STATUS_ORDER = [
  "NEW",
  "AWAITING_REVIEW",
  "AWAITING_CUSTOMER",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
];

export default function ConversationsList({
  items,
  nowMs,
}: {
  items: ConversationListItem[];
  nowMs: number;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [participation, setParticipation] = useState("all");
  const [sort, setSort] = useState("newest");
  const now = new Date(nowMs);

  const statuses = useMemo(() => {
    const present = new Set(items.map((i) => i.status));
    return STATUS_ORDER.filter((s) => present.has(s));
  }, [items]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    // filter() returns a fresh array, so sorting it in place is safe.
    const r = items.filter((i) => {
      if (status !== "all" && i.status !== status) return false;
      if (participation === "outbound" && !i.outboundOnly) return false;
      if (participation === "withCustomer" && i.outboundOnly) return false;
      if (term) {
        const hay =
          `#${i.ref} ${i.customerName ?? ""} ${i.customerEmail} ${i.subject ?? ""} ${i.preview} ${i.orderNumber ?? ""}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    if (sort === "oldest") return r.sort((a, b) => ts(a.lastActivity) - ts(b.lastActivity));
    return r.sort((a, b) => ts(b.lastActivity) - ts(a.lastActivity));
  }, [items, q, status, participation, sort]);

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
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Όλα τα status</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {conversationStatusLabel(s)}
            </option>
          ))}
        </select>
        <select value={participation} onChange={(e) => setParticipation(e.target.value)}>
          <option value="all">Όλες οι συμμετοχές</option>
          <option value="outbound">{OUTBOUND_ONLY_LABEL}</option>
          <option value="withCustomer">Με συμμετοχή πελάτη</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="newest">Ταξ.: Νεότερα</option>
          <option value="oldest">Ταξ.: Παλαιότερα</option>
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
              key={item.conversationId}
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
                  {relativeTime(new Date(item.lastActivity), now)}
                </div>
              </div>

              <div className="queue-item-subject">{item.subject ?? "(χωρίς θέμα)"}</div>
              {item.preview && <p className="queue-item-preview">{item.preview}…</p>}

              <div className="queue-item-meta">
                <span className={conversationStatusBadgeClass(item.status)}>
                  {conversationStatusLabel(item.status)}
                </span>
                {item.outboundOnly && <span className="badge info">{OUTBOUND_ONLY_LABEL}</span>}
                {item.intent && <span className="badge">{intentLabel(item.intent)}</span>}
                {item.draftStatus && (
                  <span className="badge neutral">
                    Draft: {DRAFT_STATUS_LABELS[item.draftStatus] ?? item.draftStatus}
                  </span>
                )}
                <span className="badge neutral">{item.messageCount} μηνύματα</span>
                {item.orderNumber && (
                  <span className="badge neutral">παρ. #{item.orderNumber}</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
