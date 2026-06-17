export default function Home() {
  return (
    <main>
      <h1>TFP Customer Service Agent</h1>
      <p style={{ color: "var(--muted)" }}>
        Review dashboard — υπό κατασκευή (Phase 3).
      </p>

      <h2>Κατάσταση</h2>
      <ul>
        <li>
          Health check υπηρεσιών: <a href="/api/health">/api/health</a>
        </li>
      </ul>

      <h2>Επόμενα</h2>
      <ol>
        <li>Phase 1 — Ingestion &amp; threading (Microsoft Graph)</li>
        <li>Phase 2 — Agent core (bounded context) &amp; knowledge</li>
        <li>Phase 3 — Red lines &amp; review dashboard (αυτή η οθόνη)</li>
        <li>Phase 4 — Sending &amp; follow-ups</li>
      </ol>
    </main>
  );
}
