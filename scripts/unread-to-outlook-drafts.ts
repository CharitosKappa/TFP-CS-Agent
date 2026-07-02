import "dotenv/config";
import { getEnv } from "../src/lib/env";
import { classifyEmail } from "../src/lib/agent/classify";
import { draftReplyForInbound } from "../src/lib/agent/pipeline";
import { fetchInboundMedia } from "../src/lib/agent/process";
import { recentMessagesFromThread, relatedThreadsFromGraph } from "../src/lib/agent/thread-context";
import { loadPolicies } from "../src/lib/knowledge/policies";
import { gatherShopifyContext } from "../src/lib/shopify/context";
import { gatherOdooContext } from "../src/lib/odoo/context";
import { fetchOdooAttachment } from "../src/lib/odoo/attachments";
import { createReplyDraft, fetchInboxMessages, flagMessage, type OutgoingAttachment } from "../src/lib/graph/messages";
import { createPlannerTask } from "../src/lib/graph/planner";
import { htmlToText, stripQuotedReply, textToHtml } from "../src/lib/ingestion/html";

// One-off: for every CURRENTLY-UNREAD inbox email in the support mailbox, run the
// agent and leave a reply DRAFT in Outlook (unsent) for a human to review/send.
// Does NOT write to the app DB, does NOT mark anything read, does NOT send mail.
//   npx tsx scripts/unread-to-outlook-drafts.ts [limit]
const limit = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 50;

async function main() {
  const mailbox = getEnv().GRAPH_MAILBOX.toLowerCase();
  const policies = await loadPolicies();

  const unread = await fetchInboxMessages({ unreadOnly: true, limit });
  console.log(`Found ${unread.length} unread inbox message(s) (limit ${limit}).`);

  let drafted = 0, skipped = 0, escalated = 0, withVoucher = 0, failed = 0;

  for (const msg of unread) {
    const from = msg.from?.emailAddress?.address?.toLowerCase();
    const subject = msg.subject ?? undefined;
    try {
      // Inbox should be customer→us, but skip anything from our own mailbox.
      if (!from || from === mailbox) { skipped++; continue; }

      const rawHtml = msg.body?.content ?? msg.bodyPreview ?? "";
      const text = stripQuotedReply(htmlToText(rawHtml));
      if (!text.trim()) { console.log(`- skip (empty body): ${subject}`); skipped++; continue; }

      const classification = await classifyEmail(text, subject);
      if (!classification.requiresReply) {
        console.log(`- skip (no reply needed): ${subject}`);
        skipped++;
        continue;
      }

      const media = await fetchInboundMedia(msg.id);
      // Thread-aware: pull prior messages of THIS conversation from Graph so the
      // draft is never blind to the history (no DB needed).
      const recentMessages = await recentMessagesFromThread(
        msg.conversationId,
        msg.id,
        new Date(msg.receivedDateTime),
      );
      // Cross-thread: the customer's OTHER conversations (they often open a new
      // email instead of replying), so the draft doesn't repeat what we already
      // sent about the same issue.
      const relatedContext = await relatedThreadsFromGraph(from, msg.conversationId);
      const result = await draftReplyForInbound({
        policies,
        caseSummary: "",
        recentMessages,
        relatedContext,
        incomingMessage: text,
        subject,
        images: media.images,
        attachmentSummary: media.summary,
        classification,
        gatherShopify: (c) =>
          gatherShopifyContext({
            orderNumber: c.orderNumber,
            customerEmail: c.customerEmail || from,
            couponCode: c.couponCode,
            intent: c.intent,
          }),
        gatherOdoo: (c) =>
          gatherOdooContext({
            orderNumber: c.orderNumber,
            customerEmail: c.customerEmail || from,
            intent: c.intent,
            asksForReturnLabel: c.asksForReturnLabel,
          }),
      });

      // Attach the real voucher when the agent resolved one (same rule as send.ts).
      const attachments: OutgoingAttachment[] = [];
      if (result.voucherAttachmentId) {
        const att = await fetchOdooAttachment(result.voucherAttachmentId);
        if (att) {
          attachments.push({ name: att.name, contentType: att.mimetype, base64: att.base64 });
          withVoucher++;
        } else {
          console.log(`  ! voucher ${result.voucherAttachmentId} not fetched for ${subject}`);
        }
      }

      // Flag + tag escalated cases in Outlook so a human scrutinises them.
      const escalate = result.redline.escalate;
      const categories = escalate
        ? ["TFP: Escalate", ...result.redline.reasons.map((r) => `reason: ${r}`)]
        : undefined;
      const { graphMessageId, webLink } = await createReplyDraft(msg.id, textToHtml(result.content), {
        attachments,
        categories,
        flagged: escalate,
      });
      // Also flag/tag the customer's INBOUND message so the escalation is visible
      // in the inbox (categories on the draft alone sit in the Drafts folder).
      if (escalate) await flagMessage(msg.id, { categories, flagged: true });

      // A follow-up or escalation needs a human to act/decide → create a Planner
      // task so it's tracked on the team board, not just as an email in Drafts.
      if (result.promisesFollowUp || escalate) {
        // Clean, consistent SHORT title: "<essence> — #<order>"; details in notes.
        const essence = result.followUpTitle || (escalate ? "Έλεγχος/απόφαση" : "Follow-up");
        const title = classification.orderNumber ? `${essence} — #${classification.orderNumber}` : essence;
        const notes = [
          result.followUpDetails || "Χρειάζεται ανθρώπινη ενέργεια/απόφαση (βλ. draft).",
          "",
          "— Στοιχεία —",
          `Πελάτης: ${from}`,
          subject ? `Θέμα: ${subject}` : "",
          classification.orderNumber ? `Παραγγελία: #${classification.orderNumber}` : "",
          escalate ? `Escalation: ${result.redline.reasons.join(", ")}` : "",
          `Draft (Outlook): ${webLink ?? "(δες φάκελο Drafts)"}`,
        ].filter(Boolean).join("\n");
        const taskId = await createPlannerTask({ title, description: notes });
        if (taskId) console.log(`  → Planner task: ${title}`);
      }
      drafted++;
      if (escalate) escalated++;
      console.log(
        `✓ draft: «${subject ?? "(no subject)"}» from ${from}` +
          `${result.redline.escalate ? ` [ESCALATED: ${result.redline.reasons.join(",")}]` : ""}` +
          `${attachments.length ? " [voucher attached]" : ""} → ${graphMessageId.slice(0, 12)}…`,
      );
    } catch (e) {
      failed++;
      console.error(`✗ failed: «${subject}» — ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\nDone. drafted=${drafted} skipped=${skipped} failed=${failed} (escalated=${escalated}, voucher=${withVoucher})`);
  if (escalated > 0) {
    console.log(`⚠ ${escalated} draft(s) are flagged ESCALATED — review those especially carefully before sending.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
