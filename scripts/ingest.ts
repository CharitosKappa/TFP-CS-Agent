import "dotenv/config";
import { syncInbox } from "../src/lib/ingestion/sync";

// Usage: npx tsx scripts/ingest.ts [limit]  (per folder: Inbox + Sent Items)
const parsed = Number(process.argv[2] ?? "50");
const limit = Number.isFinite(parsed) ? parsed : 50;

syncInbox({ limit })
  .then((r) => {
    console.log("Sync complete:", r);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
