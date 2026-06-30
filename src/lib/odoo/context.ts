import type { Intent } from "../agent/types";
import { log } from "../observability/logger";
import { findRmasByCustomerEmail, findRmasByOrder, type RmaSummary } from "./rma";

// RMA states considered CLOSED. Everything else (pending/processing/received/
// validated/locked) is "active" — a return still in progress. Adjust here if the
// business treats "locked" as closed.
const TERMINAL_STATES = new Set(["processed", "cancel", "invalid"]);

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

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
    `- Κατάσταση: ${r.state}`,
    r.orderName ? `- Παραγγελία: ${r.orderName}` : "",
    r.refundMethod
      ? `- Τρόπος επιστροφής χρημάτων: ${r.refundMethod}${r.refundAmount ? ` (${r.refundAmount})` : ""}`
      : "",
    r.returnTrackingUrl
      ? `- Ετικέτα/voucher επιστροφής: έχει εκδοθεί και απεστάλη συνημμένη στο email αποδοχής του RMA`
      : "",
    items ? `- Είδη προς επιστροφή: ${items}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Fetches the Odoo RMA relevant to a message (fresh, on-demand) and formats it
 * for the prompt. Surfaces the latest ACTIVE return; if none is active, falls
 * back to the most recent RMA of any state so the agent still has ground truth
 * for a just-completed return. Best-effort: never throws — an Odoo failure must
 * not block drafting.
 */
export async function gatherOdooContext(input: {
  customerEmail?: string;
  orderNumber?: string;
  intent?: Intent;
}): Promise<string | undefined> {
  try {
    // Prefer the order when known (most precise); else look up by customer email.
    let rmas: RmaSummary[] = [];
    if (input.orderNumber) rmas = await findRmasByOrder(input.orderNumber);
    if (rmas.length === 0 && input.customerEmail) {
      rmas = await findRmasByCustomerEmail(input.customerEmail);
    }
    if (rmas.length === 0) return undefined;

    // rmas come back newest-first.
    const chosen = rmas.find((r) => !TERMINAL_STATES.has(r.stateCode)) ?? rmas[0];
    return formatRma(chosen);
  } catch {
    // Keep PII out of logs; the lookup detail is logged in rma/client already.
    log.error("odoo_context_failed", {});
    return undefined;
  }
}
