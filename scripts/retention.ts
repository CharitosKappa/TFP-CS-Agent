import "dotenv/config";
import { purgeExpiredData, retentionDays } from "../src/lib/privacy/retention";

// Usage:
//   npx tsx scripts/retention.ts            → purge data older than RETENTION_DAYS
//   npx tsx scripts/retention.ts --dry-run  → report what would be deleted
//   npx tsx scripts/retention.ts --days 365 → override the window
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysIdx = args.indexOf("--days");
const days = daysIdx !== -1 ? Number(args[daysIdx + 1]) : undefined;

(async () => {
  console.log(`Retention window: ${days ?? retentionDays()} days${dryRun ? " (dry run)" : ""}`);
  console.log(await purgeExpiredData({ days, dryRun }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
