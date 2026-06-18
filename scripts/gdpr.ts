import "dotenv/config";
import { eraseCustomer, exportCustomer } from "../src/lib/privacy/retention";

// Usage:
//   npx tsx scripts/gdpr.ts export <email>   → print all stored data as JSON (DSAR)
//   npx tsx scripts/gdpr.ts erase  <email>   → permanently delete all of a customer's data
const [cmd, email] = process.argv.slice(2);

(async () => {
  if (!email || (cmd !== "export" && cmd !== "erase")) {
    console.error("Usage: tsx scripts/gdpr.ts <export|erase> <email>");
    process.exit(1);
  }
  if (cmd === "export") {
    console.log(JSON.stringify(await exportCustomer(email), null, 2));
  } else {
    console.log(await eraseCustomer(email));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
