import { getAllConversations } from "@/lib/review/queue";
import ConversationsList from "./ConversationsList";

export const dynamic = "force-dynamic";

export default async function ConversationsPage() {
  const items = await getAllConversations();

  return (
    <main>
      <div className="page-head">
        <h1>Όλες οι συνομιλίες</h1>
        <span className="sub">
          {items.length === 0 ? "καμία συνομιλία" : `${items.length} συνομιλίες`}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="big">Άδειο ✦</div>
          <div>
            Δεν έχει εισαχθεί καμία συνομιλία ακόμη. Τρέξτε <code>npm run ingest</code>.
          </div>
        </div>
      ) : (
        <ConversationsList items={items} nowMs={Date.now()} />
      )}
    </main>
  );
}
