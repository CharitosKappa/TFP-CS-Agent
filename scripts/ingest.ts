import "dotenv/config";
import { syncInbox } from "../src/lib/ingestion/sync";

// Usage: npx tsx scripts/ingest.ts [limit]
const parsed = Number(process.argv[2] ?? "25");
const limit = Number.isFinite(parsed) ? parsed : 25;

syncInbox({ limit })
  .then((r) => {
    console.log("Sync complete:", r);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
