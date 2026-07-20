import { fmtDate } from "../util/date";
import { log } from "../observability/logger";
import {
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
    r.returnWaybill
      ? `- Αριθμός waybill επιστροφής (DHL): ${r.returnWaybill} — ΔΩΣ' ΤΟΝ ΑΠΕΥΘΕΙΑΣ στον πελάτη όταν του εξηγείς πώς να παραδώσει/προγραμματίσει την επιστροφή (drop-off, τοπική DHL ή MyDHL+), αντί να τον παραπέμπεις γενικά στο email του RMA`
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
 * reference it as attached. Best-effort: never throws — an Odoo failure must not
 * block drafting.
 */
export async function gatherOdooContext(input: {
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
    if (records.length === 0) return undefined;

    // Records come back newest-first: prefer the latest active, else the newest.
    const chosenRecord =
      records.find((r) => !TERMINAL_STATES.has(r.state || "")) ?? records[0];
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
    return { text, voucherAttachmentId };
  } catch {
    // Keep PII out of logs; the lookup detail is logged in rma/client already.
    log.error("odoo_context_failed", {});
    return undefined;
  }
}
