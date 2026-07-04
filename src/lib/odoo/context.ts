import { fmtDate } from "../util/date";
import { log } from "../observability/logger";
import {
  findRmaRecordsByCustomerEmail,
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
    r.refundMethod
      ? `- Τρόπος επιστροφής ΧΡΗΜΑΤΩΝ: ${r.refundMethod}${r.refundAmount ? ` (${r.refundAmount})` : ""}`
      : "",
    r.refundPaymentStatus
      ? `- Κατάσταση επιστροφής ΧΡΗΜΑΤΩΝ: ${r.refundPaymentStatus} (ΔΙΑΦΟΡΕΤΙΚΟ από την κατάσταση RMA — μόνο «Paid» σημαίνει ότι έχουν σταλεί τα χρήματα)`
      : "",
    r.returnTrackingUrl
      ? `- Ετικέτα/voucher επιστροφής: έχει εκδοθεί και απεστάλη συνημμένη στο email αποδοχής του RMA`
      : "",
    items ? `- Είδη προς επιστροφή: ${items}` : "",
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
  /** Customer explicitly asked to receive/resend the return voucher. */
  asksForReturnLabel?: boolean;
}): Promise<OdooGatherResult | undefined> {
  try {
    // Prefer the order when known (most precise); else look up by customer email.
    // Search returns lightweight records; we hydrate only the one we keep.
    let records: RmaRecord[] = [];
    if (input.orderNumber) records = await findRmaRecordsByOrder(input.orderNumber);
    if (records.length === 0 && input.customerEmail) {
      records = await findRmaRecordsByCustomerEmail(input.customerEmail);
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
