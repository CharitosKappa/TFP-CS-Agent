import "dotenv/config";
import { getEnv } from "../src/lib/env";
import { classifyEmail } from "../src/lib/agent/classify";
import { draftReplyForInbound } from "../src/lib/agent/pipeline";
import { fetchInboundMedia } from "../src/lib/agent/inbound-media";
import { recentMessagesFromThread, relatedThreadsFromGraph } from "../src/lib/agent/thread-context";
import { loadPolicies } from "../src/lib/knowledge/policies";
import { gatherShopifyContext } from "../src/lib/shopify/context";
import { gatherOdooContext } from "../src/lib/odoo/context";
import { fetchOdooAttachment } from "../src/lib/odoo/attachments";
import {
  AI_CATEGORY,
  DRAFTED_CATEGORY,
  createNewDraft,
  createReplyDraft,
  fetchInboxMessages,
  flagMessage,
  type OutgoingAttachment,
} from "../src/lib/graph/messages";
import { createPlannerTask } from "../src/lib/graph/planner";
import { htmlToText, stripQuotedReply, formatReplyHtml } from "../src/lib/ingestion/html";
import { disclaimerFor } from "../src/lib/agent/disclaimer";
import {
  contactFormSubject,
  isShopifyContactForm,
  parseShopifyContactForm,
} from "../src/lib/ingestion/contact-form";

// One-off: for every CURRENTLY-UNREAD inbox email in the support mailbox, run the
// agent and leave a reply DRAFT in Outlook (unsent) for a human to review/send.
// Does NOT write to the app DB, does NOT mark anything read, does NOT send mail.
//   npx tsx scripts/unread-to-outlook-drafts.ts [limit]
const limit = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 50;

/**
 * Masks an email for logs (a***@example.com). These scripts are the CI
 * entrypoints and all stdout lands in GitHub Actions run logs (retained,
 * repo-readable) — so per-message logs use a masked address + the message id,
 * never the raw email, subject, or draft body.
 */
function maskEmail(email: string | undefined): string {
  if (!email) return "***";
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
}

async function main() {
  const mailbox = getEnv().GRAPH_MAILBOX.toLowerCase();
  const policies = await loadPolicies();

  // Exclude already-drafted at the source so a repeating run always fetches fresh
  // work (the client-side DRAFTED skip below stays as a backstop).
  const unread = await fetchInboxMessages({ unreadOnly: true, limit, excludeCategory: DRAFTED_CATEGORY });
  console.log(`Found ${unread.length} unread inbox message(s) (limit ${limit}).`);

  let drafted = 0, skipped = 0, alreadyDrafted = 0, escalated = 0, withVoucher = 0, failed = 0;

  for (const msg of unread) {
    const from = msg.from?.emailAddress?.address?.toLowerCase();
    const subject = msg.subject ?? undefined;
    try {
      // Inbox should be customer→us, but skip anything from our own mailbox.
      if (!from || from === mailbox) { skipped++; continue; }

      // Idempotency guard: this message already has an agent draft (we tag the
      // inbound after drafting). Skip so a repeating/scheduled run never
      // re-drafts it. The tag is per-MESSAGE, so a NEW message in the same
      // thread (untagged) still gets its own draft.
      if (msg.categories?.includes(DRAFTED_CATEGORY)) { alreadyDrafted++; continue; }

      const rawHtml = msg.body?.content ?? msg.bodyPreview ?? "";
      const bodyText = htmlToText(rawHtml);

      // Shopify contact-form: the inbound is from mailer@shopify.com, but the real
      // customer (+ their message) is in the Reply-To header / body. We must reply
      // to the customer as a NEW email, not in-thread to the Shopify mailer.
      const isContactForm = isShopifyContactForm(from, bodyText);
      const parsed = isContactForm ? parseShopifyContactForm(bodyText) : null;
      const customer =
        (isContactForm
          ? msg.replyTo?.[0]?.emailAddress?.address?.toLowerCase() || parsed?.email
          : from) || from;
      const text = isContactForm
        ? parsed?.message?.trim() || stripQuotedReply(bodyText)
        : stripQuotedReply(bodyText);
      if (!text.trim()) { console.log(`- skip (empty body): ${msg.id.slice(0, 12)}…`); skipped++; continue; }

      const classification = await classifyEmail(text, subject);
      if (!classification.requiresReply) {
        console.log(`- skip (no reply needed): ${msg.id.slice(0, 12)}…`);
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
      const relatedContext = await relatedThreadsFromGraph(customer, msg.conversationId);

      // SECURITY: the classifier may lift an email out of the (attacker-controllable)
      // body. If it names someone OTHER than the verified sender, we must NOT look
      // that person up — doing so leaks a different customer's orders/PII into this
      // reply. Flag it instead so a human verifies identity before sending.
      const bodyEmail = classification.customerEmail?.toLowerCase();
      const identityMismatch = !!bodyEmail && bodyEmail !== customer;

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
        // Account/PII lookups are keyed to the VERIFIED sender (`customer`), never
        // to `c.customerEmail` (model-extracted from the body). A different body
        // email escalates via identityMismatch above; it never redirects lookups.
        gatherShopify: (c, { productHandles }) =>
          gatherShopifyContext({
            orderNumber: c.orderNumber,
            customerEmail: customer,
            couponCode: c.couponCode,
            productHandles,
          }),
        gatherOdoo: (c) =>
          gatherOdooContext({
            orderNumber: c.orderNumber,
            customerEmail: customer,
            asksForReturnLabel: c.asksForReturnLabel,
          }),
      });

      // Attach the real voucher when the agent resolved one.
      const attachments: OutgoingAttachment[] = [];
      if (result.voucherAttachmentId) {
        const att = await fetchOdooAttachment(result.voucherAttachmentId);
        if (att) {
          attachments.push({ name: att.name, contentType: att.mimetype, base64: att.base64 });
          withVoucher++;
        } else {
          console.log(`  ! voucher ${result.voucherAttachmentId} not fetched for ${msg.id.slice(0, 12)}…`);
        }
      }

      // Escalation tags surfaced on both the draft and the inbound message.
      // An identity mismatch (body names a different email) also forces review.
      const reasons = identityMismatch
        ? [...result.redline.reasons, "body names a different email — verify identity before sending"]
        : result.redline.reasons;
      const escalate = result.redline.escalate || identityMismatch;
      const escalationCats = escalate
        ? ["TFP: Escalate", ...reasons.map((r) => `reason: ${r}`)]
        : [];
      // The draft is AI-generated → always tag it "Ai" (+ escalation tags).
      const bodyHtml = formatReplyHtml(result.content, disclaimerFor(classification.language));
      const draftCategories = [AI_CATEGORY, ...escalationCats];
      let graphMessageId: string;
      let webLink: string | null | undefined;
      if (isContactForm) {
        // Fresh email TO the real customer (not an in-thread reply to the mailer).
        ({ graphMessageId, webLink } = await createNewDraft({
          to: customer,
          subject: contactFormSubject(classification.language),
          bodyHtml,
          categories: draftCategories,
          flagged: escalate,
        }));
      } else {
        ({ graphMessageId, webLink } = await createReplyDraft(msg.id, bodyHtml, {
          attachments,
          categories: draftCategories,
          flagged: escalate,
        }));
      }
      // Tag the customer's INBOUND message: the DRAFTED guard (so a scheduled run
      // won't re-draft it) + escalation tags/flag when escalated (visible in the
      // inbox — categories on the draft alone sit in the Drafts folder). Merge with
      // any existing categories so nothing already there is lost.
      const inboundCategories = Array.from(
        new Set([...(msg.categories ?? []), DRAFTED_CATEGORY, ...escalationCats]),
      );
      await flagMessage(msg.id, { categories: inboundCategories, flagged: escalate });

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
          `Πελάτης: ${customer}${isContactForm ? " (Shopify contact form)" : ""}`,
          subject ? `Θέμα: ${subject}` : "",
          classification.orderNumber ? `Παραγγελία: #${classification.orderNumber}` : "",
          escalate ? `Escalation: ${reasons.join(", ")}` : "",
          `Draft (Outlook): ${webLink ?? "(δες φάκελο Drafts)"}`,
          `ref: ${msg.id}`, // machine-readable link back to the conversation (do not edit)
          "──────────────────────────────",
          "✍️ ΑΠΟΦΑΣΗ / ΕΝΕΡΓΕΙΑ (συμπλήρωσε εδώ ο συνεργάτης, μετά κλείσε το task):",
          "» ",
        ].filter(Boolean).join("\n");
        const taskId = await createPlannerTask({ title, description: notes });
        if (taskId) console.log(`  → Planner task: ${title}`);
      }
      drafted++;
      if (escalate) escalated++;
      console.log(
        `✓ draft → ${maskEmail(customer)}${isContactForm ? " [contact-form]" : ""}` +
          `${escalate ? ` [ESCALATED: ${reasons.join(",")}]` : ""}` +
          `${attachments.length ? " [voucher attached]" : ""} → ${graphMessageId.slice(0, 12)}…`,
      );
    } catch (e) {
      failed++;
      console.error(`✗ failed: ${msg.id.slice(0, 12)}… — ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\nDone. drafted=${drafted} skipped=${skipped} alreadyDrafted=${alreadyDrafted} failed=${failed} (escalated=${escalated}, voucher=${withVoucher})`);
  if (escalated > 0) {
    console.log(`⚠ ${escalated} draft(s) are flagged ESCALATED — review those especially carefully before sending.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
