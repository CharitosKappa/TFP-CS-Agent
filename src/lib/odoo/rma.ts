import { execKw } from "./client";

// Read-only lookups against the custom `sale.order.rma` module on staging/prod.
// The agent uses these to tell a customer where their return/RMA stands. All
// access is read-only — the bound Odoo user has no write rights, so even a
// stray write method would be refused server-side.

// A many2one comes back from Odoo as [id, displayName], or false when unset.
type Many2One = [number, string] | false;

// Canonical (English) labels for the module's selection fields, verified
// against sale.order.rma on staging. These are an INTERNAL representation: the
// agent translates them into the customer's language at draft time, so we don't
// localise here. Raw codes stay available alongside (stateCode) so callers can
// branch on a stable value rather than on display text.
const RMA_STATE: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  received: "Received",
  validated: "Validated",
  processed: "Processed",
  invalid: "Invalid",
  locked: "Locked",
  cancel: "Cancelled",
};

const REFUND_METHOD: Record<string, string> = {
  credit_store: "Store credit",
  iban: "Bank transfer (IBAN)",
  prepaid: "Prepaid",
};

const RETURN_REASON: Record<string, string> = {
  missfit: "Doesn't fit",
  change_opinion: "Changed mind",
  defect: "Defective",
  wrong_product: "Wrong product",
  no_input: "Not specified",
};

// Payment status of the MONEY refund (the reverse move), distinct from the RMA
// state (which is about the returned PRODUCTS). "paid" = the customer has been
// refunded; anything else means it hasn't completed yet.
const REFUND_PAYMENT_STATE: Record<string, string> = {
  not_paid: "Not paid yet",
  in_payment: "Registered, not yet paid out",
  paid: "Paid (completed)",
  partial: "Partially paid",
  reversed: "Reversed",
  invoicing_legacy: "Unknown (legacy)",
};

export interface RmaLine {
  product: string | null;
  quantity: number;
  reason: string;
  remarks: string | null;
}

export interface RmaSummary {
  id: number;
  name: string;
  /** Raw state code (stable for branching), e.g. "received". */
  stateCode: string;
  /** Human-readable state, e.g. "Received". */
  state: string;
  orderName: string | null;
  customer: string | null;
  refundMethod: string | null;
  /**
   * GROSS refund (Odoo `refund_amount`) — the credited value of the returned
   * item, BEFORE the return-shipping deduction. NOT what the customer actually
   * gets back when a return cost applies (see refundPaidAmount).
   */
  refundAmount: number;
  /**
   * Return-shipping cost deducted from the refund (from the RMA's service-cost
   * move `amount_total`). 0 when the return is free (e.g. store credit / our error).
   */
  serviceCost: number;
  /**
   * NET amount actually refunded to the customer (Odoo `refund_payment_amount`):
   * refundAmount − serviceCost. null when no refund payment has been made yet.
   * This is the figure the customer sees — use it, not refundAmount, when
   * telling them how much was returned.
   */
  refundPaidAmount: number | null;
  /**
   * Status of the MONEY refund itself (distinct from `state`, which is the
   * PRODUCT return). null when there's no refund move yet. Only "Paid" means the
   * customer has actually received the money.
   */
  refundPaymentStatus: string | null;
  /** Carrier return-label URL, when the RMA has been sent. */
  returnTrackingUrl: string | null;
  /** Odoo ir.attachment id of the courier voucher PDF on this RMA, if present. */
  voucherAttachmentId: number | null;
  createdAt: string | null;
  lines: RmaLine[];
}

// Loose shapes for the raw Odoo records — every field can be false when unset.
interface RawRmaLine {
  id: number;
  product_id: Many2One;
  product_return_qty: number;
  return_reason: string | false;
  remarks: string | false;
}

// A raw RMA record from search_read — cheap to fetch in bulk. Lines and the
// voucher attachment are NOT included; call hydrateRma() to add them for the one
// record you actually need (avoids hydrating candidates you'll discard).
export interface RmaRecord {
  id: number;
  name: string | false;
  state: string | false;
  order_id: Many2One;
  partner_id: Many2One;
  refund_method: string | false;
  refund_amount: number;
  refund_payment_amount: number;
  service_cost_move_id: Many2One;
  reverse_move_payment_state: string | false;
  dhl_locator_url: string | false;
  create_date: string | false;
  line_ids: number[];
}

const RMA_FIELDS = [
  "name", "state", "order_id", "partner_id", "refund_method",
  "refund_amount", "refund_payment_amount", "service_cost_move_id",
  "reverse_move_payment_state", "dhl_locator_url", "create_date", "line_ids",
];

const m2oName = (v: Many2One): string | null => (Array.isArray(v) ? v[1] : null);
const orNull = (v: string | false): string | null => (v === false ? null : v);

/** Reads the RMA lines for a set of ids and maps them by id. */
async function fetchLines(ids: number[]): Promise<Map<number, RmaLine>> {
  const byId = new Map<number, RmaLine>();
  if (ids.length === 0) return byId;
  const rows = await execKw<RawRmaLine[]>("sale.order.rma.line", "read", [ids], {
    fields: ["product_id", "product_return_qty", "return_reason", "remarks"],
  });
  for (const r of rows) {
    byId.set(r.id, {
      product: m2oName(r.product_id),
      quantity: r.product_return_qty,
      reason: r.return_reason ? (RETURN_REASON[r.return_reason] ?? r.return_reason) : "Not specified",
      remarks: orNull(r.remarks),
    });
  }
  return byId;
}

/**
 * Maps each RMA id to its courier voucher attachment id. Prefers an attachment
 * whose name looks like a voucher; falls back to the newest PDF on the RMA.
 */
async function fetchVoucherIds(rmaIds: number[]): Promise<Map<number, number>> {
  const byRma = new Map<number, number>();
  if (rmaIds.length === 0) return byRma;
  const rows = await execKw<{ id: number; res_id: number; name: string | false }[]>(
    "ir.attachment", "search_read",
    [[
      ["res_model", "=", "sale.order.rma"],
      ["res_id", "in", rmaIds],
      ["mimetype", "=", "application/pdf"],
    ]],
    { fields: ["res_id", "name"], order: "id desc" }, // newest first
  );
  for (const a of rows) {
    const looksLikeVoucher = /voucher/i.test(a.name || "");
    // Take the first PDF seen per RMA (newest), but let a voucher-named one win.
    if (!byRma.has(a.res_id) || looksLikeVoucher) byRma.set(a.res_id, a.id);
  }
  return byRma;
}

/**
 * Reads the €-amount of an RMA's service-cost move (the return-shipping fee
 * deducted from the refund), from account.move.amount_total. Best-effort: 0 when
 * there's no such move or it can't be read (a free return has none).
 */
async function fetchServiceCost(moveId: Many2One): Promise<number> {
  if (!Array.isArray(moveId)) return 0;
  try {
    const rows = await execKw<{ amount_total: number }[]>(
      "account.move", "search_read",
      [[["id", "=", moveId[0]]]],
      { fields: ["amount_total"], limit: 1 },
    );
    return rows[0]?.amount_total ?? 0;
  } catch {
    return 0; // no read access / no move — treat as no deduction
  }
}

function toSummary(
  r: RmaRecord,
  lines: Map<number, RmaLine>,
  voucherAttachmentId: number | null,
  serviceCost: number,
): RmaSummary {
  const stateCode = r.state || "";
  return {
    id: r.id,
    name: r.name || `RMA-${r.id}`,
    stateCode,
    state: RMA_STATE[stateCode] ?? stateCode ?? "Unknown",
    orderName: m2oName(r.order_id),
    customer: m2oName(r.partner_id),
    refundMethod: r.refund_method ? (REFUND_METHOD[r.refund_method] ?? r.refund_method) : null,
    refundAmount: r.refund_amount ?? 0,
    serviceCost,
    // refund_payment_amount is the net actually paid; 0/absent → not refunded yet.
    refundPaidAmount: r.refund_payment_amount ? r.refund_payment_amount : null,
    refundPaymentStatus: r.reverse_move_payment_state
      ? (REFUND_PAYMENT_STATE[r.reverse_move_payment_state] ?? r.reverse_move_payment_state)
      : null,
    returnTrackingUrl: orNull(r.dhl_locator_url),
    voucherAttachmentId,
    createdAt: orNull(r.create_date),
    lines: (r.line_ids ?? []).map((id) => lines.get(id)).filter((l): l is RmaLine => Boolean(l)),
  };
}

/** Runs a domain search and returns raw records (no lines/voucher), newest first. */
async function searchRmaRecords(domain: unknown[], limit = 10): Promise<RmaRecord[]> {
  return execKw<RmaRecord[]>("sale.order.rma", "search_read", [domain], {
    fields: RMA_FIELDS,
    order: "create_date desc",
    limit,
  });
}

/** Adds the lines + voucher attachment + service cost to a single record (fetched concurrently). */
export async function hydrateRma(r: RmaRecord): Promise<RmaSummary> {
  const [lines, vouchers, serviceCost] = await Promise.all([
    fetchLines(r.line_ids ?? []),
    fetchVoucherIds([r.id]),
    fetchServiceCost(r.service_cost_move_id),
  ]);
  return toSummary(r, lines, vouchers.get(r.id) ?? null, serviceCost);
}

/**
 * Best-effort extraction of an RMA reference from free text (subject/body), e.g.
 * "RMA5278", "rma 5278", "RMA-5278". Returns the canonical Odoo name — "RMA" +
 * digits zero-padded to 4 (names on staging/prod read RMA0436, RMA5278, …) — or
 * undefined when the text cites none.
 */
export function extractRmaNumber(text: string): string | undefined {
  const m = text.match(/\bRMA[\s#:-]*(\d{1,6})\b/i);
  return m ? `RMA${m[1].padStart(4, "0")}` : undefined;
}

/**
 * Records of all RMAs linked to a sales order, by the order's reference (e.g.
 * "50530"). When `customerEmail` is given, only RMAs whose partner matches it
 * are returned — an order number that reached us misparsed, or that belongs to
 * someone else, must never surface another customer's return.
 */
export async function findRmaRecordsByOrder(orderName: string, customerEmail?: string): Promise<RmaRecord[]> {
  const domain: unknown[] = [["order_id.name", "=", orderName]];
  if (customerEmail) domain.push(["partner_id.email", "=ilike", customerEmail]);
  return searchRmaRecords(domain);
}

/** Records matched by the RMA reference itself (e.g. "RMA5278"); same ownership rule as above. */
export async function findRmaRecordsByName(rmaName: string, customerEmail?: string): Promise<RmaRecord[]> {
  const domain: unknown[] = [["name", "=ilike", rmaName]];
  if (customerEmail) domain.push(["partner_id.email", "=ilike", customerEmail]);
  return searchRmaRecords(domain);
}

/** Records of all RMAs for a customer, matched on the partner's email. */
export async function findRmaRecordsByCustomerEmail(email: string): Promise<RmaRecord[]> {
  return searchRmaRecords([["partner_id.email", "=ilike", email]]);
}
