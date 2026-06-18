import "dotenv/config";
import { reconcileStuckSends } from "../src/lib/review/reconcile";

// Usage:
//   npx tsx scripts/reconcile-sends.ts            → reconcile drafts stuck in SENDING
//   npx tsx scripts/reconcile-sends.ts --dry-run  → report only
//   npx tsx scripts/reconcile-sends.ts --minutes 15
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const mIdx = args.indexOf("--minutes");
const olderThanMinutes = mIdx !== -1 ? Number(args[mIdx + 1]) : undefined;

(async () => {
  console.log(await reconcileStuckSends({ dryRun, olderThanMinutes }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
