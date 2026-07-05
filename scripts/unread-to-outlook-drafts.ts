import "dotenv/config";
import { getEnv } from "../src/lib/env";
import { classifyEmail } from "../src/lib/agent/classify";
import { draftReplyForInbound } from "../src/lib/agent/pipeline";
import { judgeSameRequest } from "../src/lib/agent/dedup";
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
  markMessageRead,
  type OutgoingAttachment,
} from "../src/lib/graph/messages";
import type { GraphMessage } from "../src/lib/graph/types";
import { createPlannerTask } from "../src/lib/graph/planner";
import { htmlToText, stripQuotedReply, formatReplyHtml, withQuotedOriginal } from "../src/lib/ingestion/html";
import { disclaimerFor } from "../src/lib/agent/disclaimer";
import {
  contactFormSubject,
  isShopifyContactForm,
  originalMessageHeader,
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

  let drafted = 0, skipped = 0, alreadyDrafted = 0, escalated = 0, withVoucher = 0, failed = 0, consolidatedDupes = 0;

  // ── Resolve each message once (sender/customer/body), dropping our own mail,
  // already-drafted messages, and empty bodies. Doing this up front lets us group
  // by customer before drafting.
  const resolved: { msg: GraphMessage; customer: string; text: string; isContactForm: boolean }[] = [];
  for (const msg of unread) {
    try {
      const from = msg.from?.emailAddress?.address?.toLowerCase();
      // Inbox should be customer→us, but skip anything from our own mailbox.
      if (!from || from === mailbox) { skipped++; continue; }
      // Idempotency guard: already has an agent draft (tag is per-MESSAGE, so a
      // NEW message in the same thread still gets its own draft).
      if (msg.categories?.includes(DRAFTED_CATEGORY)) { alreadyDrafted++; continue; }

      const bodyText = htmlToText(msg.body?.content ?? msg.bodyPreview ?? "");
      // Shopify contact-form: inbound is from mailer@shopify.com, but the real
      // customer (+ message) is in Reply-To / body — reply to them as a NEW email.
      const isContactForm = isShopifyContactForm(from, bodyText);
      const parsed = isContactForm ? parseShopifyContactForm(bodyText) : null;
      const customer =
        (isContactForm
          ? msg.replyTo?.[0]?.emailAddress?.address?.toLowerCase() || parsed?.email
          : from) || from;
      const text = isContactForm
        ? stripQuotedReply(parsed?.message ?? "").trim() || stripQuotedReply(bodyText)
        : stripQuotedReply(bodyText);
      if (!text.trim()) { console.log(`- skip (empty body): ${msg.id.slice(0, 12)}…`); skipped++; continue; }
      resolved.push({ msg, customer, text, isContactForm });
    } catch (e) {
      failed++;
      console.error(`✗ resolve failed: ${msg.id.slice(0, 12)}… — ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── Consolidate same-request duplicates: when ONE customer sent several messages
  // in this batch that are the SAME request, draft ONCE (the newest) + escalate and
  // fold the rest — so the customer never gets two disconnected replies. Conservative:
  // only folds when the model is confident they're the same (see judgeSameRequest).
  const foldedInto = new Map<string, string>();  // duplicate msg id -> kept msg id
  const foldedCount = new Map<string, number>(); // kept msg id -> # of folded duplicates
  const byCustomer = new Map<string, typeof resolved>();
  for (const r of resolved) {
    const arr = byCustomer.get(r.customer) ?? [];
    arr.push(r);
    byCustomer.set(r.customer, arr);
  }
  for (const [cust, items] of byCustomer) {
    if (items.length < 2) continue;
    const same = await judgeSameRequest(items.map((i) => ({ subject: i.msg.subject ?? undefined, body: i.text })));
    if (!same) continue;
    const sorted = [...items].sort(
      (a, b) => new Date(b.msg.receivedDateTime).getTime() - new Date(a.msg.receivedDateTime).getTime(),
    );
    const keep = sorted[0];
    foldedCount.set(keep.msg.id, sorted.length - 1);
    for (const d of sorted.slice(1)) foldedInto.set(d.msg.id, keep.msg.id);
    console.log(`↯ ${sorted.length} same-request messages from ${maskEmail(cust)} → drafting once + escalating`);
  }

  for (const { msg, customer, text, isContactForm } of resolved) {
    const subject = msg.subject ?? undefined;
    try {
      // Folded (older) duplicate: a same-request sibling is being drafted once, so
      // this one is dismissed AS A REPLY OBLIGATION — mark it READ so it drops out of
      // the unread queue, and tag it (traceability + idempotency). No draft, no task,
      // no flag, no escalation: those all live on the kept (newest) message.
      const keptId = foldedInto.get(msg.id);
      if (keptId) {
        const cats = Array.from(new Set([...(msg.categories ?? []), DRAFTED_CATEGORY, "TFP: Consolidated duplicate"]));
        await flagMessage(msg.id, { categories: cats });
        await markMessageRead(msg.id);
        consolidatedDupes++;
        console.log(`↯ folded duplicate of ${keptId.slice(0, 12)}… — read + tagged, not drafted: ${msg.id.slice(0, 12)}…`);
        continue;
      }

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
            productSize: c.productSize,
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
      // Identity mismatch (body names a different email) and consolidated
      // duplicates also force review.
      const extraReasons: string[] = [];
      if (identityMismatch) extraReasons.push("body names a different email — verify identity before sending");
      const foldN = foldedCount.get(msg.id) ?? 0;
      if (foldN > 0) extraReasons.push(`consolidated: ${foldN} επιπλέον μήνυμα(τα) ίδιου αιτήματος από τον πελάτη`);
      const reasons = [...result.redline.reasons, ...extraReasons];
      const escalate = result.redline.escalate || extraReasons.length > 0;
      const escalationCats = escalate
        ? ["TFP: Escalate", ...reasons.map((r) => `reason: ${r}`)]
        : [];
      // Non-escalated drafts that still need a human action (promisesFollowUp)
      // get a visible "TFP: Follow-up" tag — the Outlook counterpart of the
      // Planner task, so the Drafts folder shows they're not "done". (Escalated
      // drafts already stand out via TFP: Escalate.)
      const followUpCats = result.promisesFollowUp && !escalate ? ["TFP: Follow-up"] : [];
      // The draft is AI-generated → always tag it "Ai" (+ escalation/follow-up tags).
      const bodyHtml = formatReplyHtml(result.content, disclaimerFor(classification.language));
      const draftCategories = [AI_CATEGORY, ...escalationCats, ...followUpCats];
      let graphMessageId: string;
      let webLink: string | null | undefined;
      if (isContactForm) {
        // Fresh email TO the real customer (not an in-thread reply to the mailer).
        // A fresh email carries no quoted history, so append the customer's original
        // message below the reply — otherwise they'd see our answer with no context.
        ({ graphMessageId, webLink } = await createNewDraft({
          to: customer,
          subject: contactFormSubject(classification.language),
          bodyHtml: withQuotedOriginal(bodyHtml, text, originalMessageHeader(classification.language)),
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
        new Set([...(msg.categories ?? []), DRAFTED_CATEGORY, ...escalationCats, ...followUpCats]),
      );
      await flagMessage(msg.id, { categories: inboundCategories, flagged: escalate });

      // A follow-up or escalation needs a human to act/decide → create a Planner
      // task so it's tracked on the team board, not just as an email in Drafts.
      if (result.promisesFollowUp || escalate) {
        // Title: "<customer email> — <essence> — #<order>"; details in notes.
        const essence = result.followUpTitle || (escalate ? "Έλεγχος/απόφαση" : "Follow-up");
        const title = [customer, essence, classification.orderNumber ? `#${classification.orderNumber}` : ""]
          .filter(Boolean)
          .join(" — ");
        // Notes: always Greek, information-rich, and structured into three parts
        // separated by a blank line — (Α) περίληψη ζητήματος, (Β) στοιχεία + draft
        // link, (Γ) απόφαση/ενέργεια. filter(Boolean) runs PER PART so absent
        // fields drop out without collapsing the blank lines between parts.
        const summaryPart = [
          "📋 ΠΕΡΙΛΗΨΗ ΖΗΤΗΜΑΤΟΣ",
          result.followUpDetails || classification.summary || "Χρειάζεται ανθρώπινη ενέργεια/απόφαση (βλ. draft).",
        ].join("\n");
        const detailsPart = [
          "— Στοιχεία —",
          `Πελάτης: ${customer}${isContactForm ? " (Shopify contact form)" : ""}`,
          subject ? `Θέμα: ${subject}` : "",
          classification.orderNumber ? `Παραγγελία: #${classification.orderNumber}` : "",
          `Κατηγορία: ${classification.intent} · Διάθεση: ${classification.sentiment}`,
          escalate ? `Κλιμάκωση: ${reasons.join(", ")}` : "",
          webLink ? "🔗 Draft: δες το link «Άνοιγμα draft (Outlook)» στο task" : "🔗 Draft: (δες φάκελο Drafts)",
          `ref: ${msg.id}`, // machine-readable link back to the conversation (do not edit)
        ].filter(Boolean).join("\n");
        const decisionPart = [
          "──────────────────────────────",
          "✍️ ΑΠΟΦΑΣΗ / ΕΝΕΡΓΕΙΑ (συμπλήρωσε εδώ ο συνεργάτης, μετά κλείσε το task):",
          "» ",
        ].join("\n");
        const notes = [summaryPart, detailsPart, decisionPart].join("\n\n");
        const taskId = await createPlannerTask({
          title,
          description: notes,
          references: webLink ? [{ url: webLink, alias: "Άνοιγμα draft (Outlook)" }] : undefined,
        });
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

  console.log(`\nDone. drafted=${drafted} skipped=${skipped} alreadyDrafted=${alreadyDrafted} consolidated=${consolidatedDupes} failed=${failed} (escalated=${escalated}, voucher=${withVoucher})`);
  if (escalated > 0) {
    console.log(`⚠ ${escalated} draft(s) are flagged ESCALATED — review those especially carefully before sending.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
