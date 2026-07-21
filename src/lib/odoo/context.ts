import { fmtDate } from "../util/date";
import { log } from "../observability/logger";
import {
  fetchSalesDocType,
  findRmaRecordsByCustomerEmail,
  findRmaRecordsByName,
  findRmaRecordsByOrder,
  hydrateRma,
  type RmaRecord,
  type RmaSummary,
} from "./rma";

// RMA states considered CLOSED. Everything else (pending/processing/received/
// validated/locked) is "active" — a return still in progress. Adjust here if the
// business treats "locked" as closed.
const TERMINAL_STATES = new Set(["processed", "cancel", "invalid"]);

// Operation-level retry for the whole Odoo lookup. resilientFetch already retries
// WITHIN each request over a few seconds — but a real outage (e.g. the auth endpoint
// down for a couple of minutes, as seen in production) outlasts that, and retrying
// seconds apart just hammers a service that needs time to recover. So we wait a full
// MINUTE between attempts, giving a transient failure real time to clear before we
// give up and let the pipeline escalate. Only THROWN failures retry — a clean
// "nothing found" does not. Trade-off: a persistent outage adds ~ATTEMPTS−1 minutes
// per return message to that run; acceptable since it only happens during an outage.
const ODOO_GATHER_ATTEMPTS = 3;
const ODOO_RETRY_DELAY_MS = 60_000;
const odooSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Compact, prompt-ready rendering of one RMA. Greek headers like the Shopify
 * block (the model translates the final reply to the customer's language).
 * Deliberately does NOT paste the carrier label URL: the label/voucher is sent
 * attached to the RMA acceptance email, and the agent must point the customer
 * there rather than hand out a fresh link (see returns guardrails).
 */
function formatRma(r: RmaSummary): string {
  const items = r.lines
    .map((l) => `${l.quantity}× ${l.product ?? "—"}${l.reason ? ` (λόγος: ${l.reason})` : ""}`)
    .join(", ");
  return [
    `Επιστροφή/RMA ${r.name}${r.createdAt ? ` (${fmtDate(r.createdAt)})` : ""}`,
    `- Κατάσταση RMA (επιστροφή ΠΡΟΪΟΝΤΩΝ): ${r.state}`,
    r.orderName ? `- Παραγγελία: ${r.orderName}` : "",
    r.refundMethod ? `- Τρόπος επιστροφής ΧΡΗΜΑΤΩΝ: ${r.refundMethod}` : "",
    // Money breakdown. When a return-shipping (service) cost applies, the customer
    // gets back the GROSS refund MINUS that cost — show the arithmetic so the agent
    // can explain "why is my refund lower than what I paid?" from data, not guesswork.
    r.serviceCost > 0
      ? `- Ανάλυση ποσού επιστροφής: μεικτό ${r.refundAmount}€ − κόστος επιστροφής ${r.serviceCost}€ = ${r.refundPaidAmount ?? (r.refundAmount - r.serviceCost)}€ (ΚΑΘΑΡΟ ποσό που επιστρέφεται/επιστράφηκε στον πελάτη)`
      : r.refundPaidAmount
        ? `- Ποσό επιστροφής χρημάτων: ${r.refundPaidAmount}€ (χωρίς κόστος επιστροφής)`
        : r.refundAmount
          ? `- Ποσό επιστροφής χρημάτων: ${r.refundAmount}€`
          : "",
    r.refundPaymentStatus
      ? `- Κατάσταση επιστροφής ΧΡΗΜΑΤΩΝ: ${r.refundPaymentStatus} (ΔΙΑΦΟΡΕΤΙΚΟ από την κατάσταση RMA — μόνο «Paid» σημαίνει ότι έχουν σταλεί τα χρήματα)`
      : "",
    r.returnTrackingUrl
      ? `- Ετικέτα/voucher επιστροφής: έχει εκδοθεί και απεστάλη συνημμένη στο email αποδοχής του RMA`
      : "",
    r.returnCarrier
      ? `- Courier επιστροφής: ${r.returnCarrier} — η επιστροφή γίνεται με ΑΥΤΟΝ τον courier. ΜΗΝ υποθέτεις άλλον (π.χ. αν εδώ λέει «Box Now», ΜΗΝ δίνεις οδηγίες DHL/MyDHL+ και αντίστροφα)`
      : "",
    r.returnWaybill
      ? `- Αριθμός waybill/tracking επιστροφής${r.returnCarrier ? ` (${r.returnCarrier})` : ""}: ${r.returnWaybill} — ΔΩΣ' ΤΟΝ ΑΠΕΥΘΕΙΑΣ στον πελάτη όπου χρειάζεται, αντί να τον παραπέμπεις γενικά στο email του RMA`
      : "",
    items ? `- Είδη προς επιστροφή: ${items}` : "",
    // Business rule: one open RMA at a time — the portal rejects a second request
    // until the current one closes (processed/cancelled). Stated on ACTIVE RMAs so
    // the agent can explain a "the portal won't let me submit" complaint.
    !TERMINAL_STATES.has(r.stateCode)
      ? `- Όσο αυτή η επιστροφή είναι ΣΕ ΕΞΕΛΙΞΗ, ο πελάτης ΔΕΝ μπορεί να υποβάλει ΝΕΟ αίτημα επιστροφής στην πύλη — νέο RMA γίνεται δεκτό μόνο όταν το τρέχον ολοκληρωθεί ή ακυρωθεί`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface OdooGatherResult {
  /** Formatted RMA block for the prompt. */
  text: string;
  /**
   * Odoo ir.attachment id of the voucher to attach to THIS reply — set only when
   * the customer asked for the label AND the chosen RMA has a voucher. The binary
   * is fetched at send time; here we only carry the reference.
   */
  voucherAttachmentId?: number;
}

/**
 * Fetches the Odoo RMA relevant to a message (fresh, on-demand) and formats it
 * for the prompt. Surfaces the latest ACTIVE return; if none is active, falls
 * back to the most recent RMA of any state so the agent still has ground truth
 * for a just-completed return. When the customer explicitly asked for the return
 * voucher and the RMA has one, flags it for attachment and tells the agent to
 * reference it as attached. Returns undefined when nothing is found (a clean
 * empty), but THROWS on a genuine Odoo failure (auth/RPC/network). One attempt —
 * gatherOdooContext wraps this with retries.
 */
async function gatherOdooContextOnce(input: {
  customerEmail?: string;
  orderNumber?: string;
  /** Canonical RMA reference cited in the email (e.g. "RMA5278") — most precise key. */
  rmaNumber?: string;
  /** Customer explicitly asked to receive/resend the return voucher. */
  asksForReturnLabel?: boolean;
}): Promise<OdooGatherResult | undefined> {
  try {
    // Precedence: explicit RMA reference → order → customer email. The first two
    // are ownership-checked against the verified sender inside the Odoo domain,
    // so a misparsed or foreign number can never surface another customer's
    // return. Search returns lightweight records; we hydrate only the one we keep.
    const email = input.customerEmail;
    let records: RmaRecord[] = [];
    if (input.rmaNumber) {
      records = await findRmaRecordsByName(input.rmaNumber, email);
      // The email cites a SPECIFIC RMA we can't match to this sender (typo, or a
      // partner email that differs from the sender). Falling back to order/email
      // would describe a DIFFERENT return than the one the customer asked about —
      // better to give the agent nothing, so it asks instead of misinforming.
      if (records.length === 0) return undefined;
    }
    // Strip the Shopify "#" prefix/whitespace before matching Odoo order_id.name
    // (the Shopify path strips it too — "#43605" would otherwise never match).
    const orderNumber = input.orderNumber?.replace(/^#/, "").trim();
    if (records.length === 0 && orderNumber) {
      records = await findRmaRecordsByOrder(orderNumber, email);
    }
    if (records.length === 0 && email) {
      records = await findRmaRecordsByCustomerEmail(email);
    }

    // Records come back newest-first: prefer the latest active, else the newest.
    const chosenRecord =
      records.length > 0 ? (records.find((r) => !TERMINAL_STATES.has(r.state || "")) ?? records[0]) : undefined;

    // Sales-document type (τιμολόγιο vs απόδειξη) for the order — from the cited
    // order number, else the found RMA's order. An INVOICED order restricts the
    // return to refund + credit note (no Store Credit), so surface it EVEN when
    // there's no RMA yet (a customer just asking how to return an invoiced order).
    const docOrder =
      orderNumber || (Array.isArray(chosenRecord?.order_id) ? chosenRecord!.order_id[1] : undefined);
    const docType = await fetchSalesDocType(docOrder);
    const docTypeLine =
      docType === "invoice"
        ? "- Παραστατικό πώλησης: ΤΙΜΟΛΟΓΙΟ (τιμολόγιο αγοράς). Στην επιστροφή διατίθεται ΜΟΝΟ επιστροφή χρημάτων με έκδοση ΠΙΣΤΩΤΙΚΟΥ τιμολογίου — το **Store Credit ΔΕΝ είναι διαθέσιμο**. ΜΗΝ προτείνεις Store Credit σε αυτή την περίπτωση."
        : "";

    if (!chosenRecord) return docTypeLine ? { text: docTypeLine } : undefined;

    const chosen = await hydrateRma(chosenRecord);
    let text = formatRma(chosen);

    // Trigger (α): attach the real voucher only when the customer asked for it
    // AND this RMA actually has one.
    let voucherAttachmentId: number | undefined;
    if (input.asksForReturnLabel && chosen.voucherAttachmentId) {
      voucherAttachmentId = chosen.voucherAttachmentId;
      text +=
        "\n- ΣΗΜΕΙΩΣΗ: το voucher επιστροφής (courier_voucher.pdf) ΕΠΙΣΥΝΑΠΤΕΤΑΙ" +
        " αυτόματα σε αυτή την απάντηση — ανάφερέ το στον πελάτη ως συνημμένο και" +
        " ΜΗΝ τον παραπέμπεις να το αναζητήσει αλλού.";
    }
    return { text: [docTypeLine, text].filter(Boolean).join("\n"), voucherAttachmentId };
  } catch (e) {
    // A genuine Odoo failure (auth/RPC/network) is NOT "nothing found" (which
    // returns undefined above). Rethrow so the wrapper can retry, then ultimately
    // the pipeline can escalate. Keep PII out of logs (detail logged in rma/client).
    log.error("odoo_context_failed", {});
    throw e;
  }
}

/**
 * Retrying wrapper around gatherOdooContextOnce. A transient Odoo failure (e.g. the
 * auth endpoint briefly down) must NOT make us draft blind — telling a customer to
 * "create an RMA" for a return that already exists. Retries the whole lookup, waiting
 * a full minute between attempts so a real blip has time to clear; a clean "nothing
 * found" (undefined) returns at once (no retry). If every attempt fails it THROWS, so
 * the pipeline escalates the reply (odoo_lookup_failed) instead of silently proceeding
 * — while the pipeline's own catch still keeps drafting unblocked.
 */
export async function gatherOdooContext(
  input: Parameters<typeof gatherOdooContextOnce>[0],
): Promise<OdooGatherResult | undefined> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ODOO_GATHER_ATTEMPTS; attempt++) {
    try {
      return await gatherOdooContextOnce(input);
    } catch (e) {
      lastErr = e;
      if (attempt < ODOO_GATHER_ATTEMPTS) await odooSleep(ODOO_RETRY_DELAY_MS);
    }
  }
  throw lastErr ?? new Error("odoo_context_failed");
}
