import "dotenv/config";
import {
  processInboundMessage,
  processNewInboundMessages,
} from "../src/lib/agent/process";

// Usage:
//   npx tsx scripts/process.ts            → draft all new inbound messages
//   npx tsx scripts/process.ts <messageId> → draft a specific message
const arg = process.argv[2];

(async () => {
  if (arg && arg !== "all") {
    console.log(await processInboundMessage(arg));
  } else {
    console.log(await processNewInboundMessages());
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
