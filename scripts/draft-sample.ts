import "dotenv/config";
import { loadPolicies } from "../src/lib/knowledge/policies";
import { draftReplyForInbound } from "../src/lib/agent/pipeline";

/**
 * Quick end-to-end test of the agent core against a sample email
 * (classify → red-line gate → draft). No mailbox/DB needed.
 *
 *   npm run dev  # not required
 *   npx tsx scripts/draft-sample.ts
 */
const SAMPLE_EMAIL = `Γεια σας, παρήγγειλα ένα φόρεμα (παραγγελία #1023) πριν 8 μέρες και
δεν έχει έρθει ακόμα. Μπορείτε να μου πείτε πού βρίσκεται; Ευχαριστώ, Μαρία`;

async function main() {
  const policies = await loadPolicies();
  const result = await draftReplyForInbound({
    policies,
    caseSummary: "",
    recentMessages: [],
    incomingMessage: SAMPLE_EMAIL,
    // shopifyContext: ... (Phase 2: real order lookup by #1023)
  });

  console.log("── Classification ─────────────────────────────");
  console.log(result.classification);
  console.log("\n── Red lines ──────────────────────────────────");
  console.log(result.redline);
  console.log("\n── Reasoning ──────────────────────────────────");
  console.log(result.reasoning);
  console.log("\n── Draft ──────────────────────────────────────");
  console.log(result.content);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
