import { getOpenFollowUps } from "@/lib/review/queue";
import FollowUpList from "./FollowUpList";

export const dynamic = "force-dynamic";

export default async function FollowUpsPage() {
  const items = await getOpenFollowUps();

  return (
    <main>
      <div className="page-head">
        <h1>Ανοιχτές εκκρεμότητες (follow-up)</h1>
        <span className="sub">
          {items.length === 0
            ? "καμία εκκρεμότητα"
            : `${items.length} προς διεκπεραίωση`}
        </span>
      </div>

      <p className="muted" style={{ marginTop: "-8px", marginBottom: 16, fontSize: "0.9rem" }}>
        Συνομιλίες όπου στείλαμε «θα επανέλθουμε» — απαιτείται ενέργεια & απάντηση από
        άνθρωπο. Όταν ολοκληρωθεί, πατήστε «Διεκπεραιώθηκε».
      </p>

      <FollowUpList items={items} nowMs={Date.now()} />
    </main>
  );
}
