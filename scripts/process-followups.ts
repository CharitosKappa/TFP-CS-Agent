import "dotenv/config";
import { classifyEmail } from "../src/lib/agent/classify";
import { draftReplyForInbound } from "../src/lib/agent/pipeline";
import { recentMessagesFromThread } from "../src/lib/agent/thread-context";
import { loadPolicies } from "../src/lib/knowledge/policies";
import { AI_CATEGORY, createReplyDraft, fetchMessage } from "../src/lib/graph/messages";
import { toBodyText } from "../src/lib/graph/message-parse";
import { appendTaskNote, getTaskDetails, listPlanTasks } from "../src/lib/graph/planner";
import { gatherShopifyContext } from "../src/lib/shopify/context";
import { gatherOdooContext } from "../src/lib/odoo/context";
import { getDiscountByCode, getLegacyDiscountByCode } from "../src/lib/shopify/discounts";
import { formatReplyHtml } from "../src/lib/ingestion/html";
import { disclaimerFor } from "../src/lib/agent/disclaimer";

// Poller: finds COMPLETED Planner follow-up tasks whose agent wrote a decision,
// then drafts a NEW customer reply that communicates that decision (e.g. a
// discount code + its terms) and leaves it in Outlook for review. Idempotent via
// an [AGENT_DRAFTED] marker appended to the task notes.
//   npx tsx scripts/process-followups.ts        (run manually now; by cron later)

const DONE_MARKER = "[AGENT_DRAFTED]";

/** Looks up a discount code's terms (modern, then legacy) — same as gatherShopify. */
async function discountTerms(code: string): Promise<string | null> {
  const d = (await getDiscountByCode(code).catch(() => null)) ??
    (await getLegacyDiscountByCode(code).catch(() => null));
  if (!d) return null;
  return `Κωδικός ${d.code}: ${d.summary ?? d.title} (κατάσταση: ${d.status}${d.endsAt ? `, λήξη ${d.endsAt.slice(0, 10)}` : ""}).`;
}

async function main() {
  const tasks = (await listPlanTasks()).filter((t) => t.percentComplete === 100);
  console.log(`Completed tasks: ${tasks.length}`);
  const policies = await loadPolicies();
  let drafted = 0;

  for (const task of tasks) {
    const { description } = await getTaskDetails(task.id);
    if (description.includes(DONE_MARKER)) continue; // already processed

    const ref = description.match(/ref:\s*(\S+)/)?.[1];
    const decision = (description.split(/✍️\s*ΑΠΟΦΑΣΗ[^\n]*\n/)[1] ?? "")
      .replace(/^[»\s]+/, "")
      .trim();
    if (!ref || !decision) continue; // not linked, or no decision written yet

    // The decision is a human's free-text note (may carry names, amounts, IBANs)
    // and stdout lands in CI logs — keep it out unless explicitly debugging.
    console.log(`\n▶ ${task.title}`);
    if (process.env.DEBUG_DRAFTS === "true") console.log(`  decision: ${decision.slice(0, 120)}`);
    try {
      const msg = await fetchMessage(ref);
      const from = (msg.from ?? msg.sender)?.emailAddress?.address?.toLowerCase() ?? "";
      const text = toBodyText(msg);
      const subject = msg.subject ?? undefined;
      const classification = await classifyEmail(text, subject);

      // If the decision names a discount code, attach its verified terms.
      const code = decision.match(/\b[A-Z0-9]{6,}\b/)?.[0];
      const terms = code ? await discountTerms(code) : null;
      const resolutionContext = terms ? `${decision}\n${terms}` : decision;

      // FULL thread up to now (empty id → exclude nothing, "now" → include our
      // previous reply) so the follow-up doesn't repeat what we already said.
      const recentMessages = await recentMessagesFromThread(msg.conversationId, "", new Date(), 10);
      const result = await draftReplyForInbound({
        policies, caseSummary: "", recentMessages, resolutionContext,
        // No NEW customer message — this is a proactive follow-up driven by the decision.
        incomingMessage:
          "[Εσωτερικό — follow-up: ΔΕΝ υπάρχει νέο μήνυμα από τον πελάτη. Με βάση το ιστορικό και την «Απόφαση/ενέργεια που ελήφθη», γράψε ένα ΣΥΝΤΟΜΟ προληπτικό μήνυμα που κοινοποιεί την απόφαση. ΜΗΝ επαναλαμβάνεις όσα έχουμε ήδη πει στο thread.]",
        subject, classification,
        // Account/PII lookups keyed to the verified sender (`from`), never to a
        // model-extracted body email — see unread-to-outlook-drafts.ts.
        gatherShopify: (c, { productHandles }) => gatherShopifyContext({ orderNumber: c.orderNumber, customerEmail: from, couponCode: c.couponCode, productHandles }),
        gatherOdoo: (c) => gatherOdooContext({ orderNumber: c.orderNumber, customerEmail: from, asksForReturnLabel: c.asksForReturnLabel }),
      });

      const { webLink } = await createReplyDraft(
        msg.id,
        formatReplyHtml(result.content, disclaimerFor(classification.language)),
        { categories: [AI_CATEGORY] }, // AI-generated draft
      );
      await appendTaskNote(task.id, DONE_MARKER);
      drafted++;
      console.log(`  ✓ follow-up draft created${terms ? " [with code]" : ""}\n  ${webLink ?? ""}`);
      // The full draft body is maximal PII — only print it when debugging locally.
      if (process.env.DEBUG_DRAFTS === "true") {
        console.log("  ── DRAFT ──\n" + result.content.split("\n").map((l) => "  " + l).join("\n"));
      }
    } catch (e) {
      console.error(`  ✗ failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\nDone. follow-up drafts created: ${drafted}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
