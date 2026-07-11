import { execKw } from "./client";
import { log } from "../observability/logger";

// Resolves a NON-order identifier a customer pasted (thinking it's their order
// number) to the real sales-order reference, via Odoo. Customers routinely quote:
//   - the receipt/invoice series  — e.g. "ΑΛΠ/2026/-16839"  (account.move.name)
//   - the warehouse-move name      — e.g. "LGK/OUT/49573"    (stock.picking.name)
//   - the parcel tracking number   — e.g. "6946881763"       (stock.picking.carrier_tracking_ref)
// Every lookup is SCOPED to the verified customer email: the same trailing number
// recurs across years/customers (ΑΛΠ/2026/16839 vs ΑΛΠ/2025/16839 are different
// people), so an unscoped match would surface a stranger's order. Read-only,
// best-effort: any failure returns null and never blocks drafting.

type Many2One = [number, string] | false;
const m2oName = (v: Many2One): string | null => (Array.isArray(v) ? v[1] : null);

// Collapse to comparable form: drop everything but letters/digits, uppercase. So
// "ΑΛΠ/2026/-16839" and "ΑΛΠ/2026/16839" (customer's stray dash) compare equal.
const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();

// Longest digit run in the identifier — the disambiguating part for an ilike probe.
function longestDigits(s: string): string | null {
  const runs = s.match(/\d+/g);
  if (!runs) return null;
  return runs.reduce((a, b) => (b.length >= a.length ? b : a));
}

/** Invoice/receipt series (account.move.name) → order, scoped by customer email. */
async function orderByInvoice(identifier: string, email: string): Promise<string | null> {
  const digits = longestDigits(identifier);
  if (!digits) return null;
  const rows = await execKw<{ name: string; invoice_origin: string | false }[]>(
    "account.move", "search_read",
    [[["name", "ilike", digits], ["partner_id.email", "=ilike", email], ["invoice_origin", "!=", false]]],
    { fields: ["name", "invoice_origin"], limit: 10 },
  );
  // Require a normalized-exact name match (tolerates only separator/dash noise like
  // the customer's "ΑΛΠ/2026/-16839"). No looser fallback: a near-miss (wrong year,
  // mistyped tail) must resolve to nothing rather than to another of the customer's
  // orders — the ilike-on-digits probe is only there to fetch candidates cheaply.
  const exact = rows.find((r) => norm(r.name) === norm(identifier));
  return exact && exact.invoice_origin ? String(exact.invoice_origin) : null;
}

/** Warehouse-move name (stock.picking.name, e.g. LGK/OUT/49573) → order, email-scoped. */
async function orderByPickingName(identifier: string, email: string): Promise<string | null> {
  const rows = await execKw<{ origin: string | false; sale_id: Many2One }[]>(
    "stock.picking", "search_read",
    [[["name", "=ilike", identifier], ["partner_id.email", "=ilike", email]]],
    { fields: ["origin", "sale_id"], limit: 3 },
  );
  const r = rows[0];
  if (!r) return null;
  return m2oName(r.sale_id) ?? (r.origin ? String(r.origin) : null);
}

/** Carrier tracking number (stock.picking.carrier_tracking_ref) → order, email-scoped. */
async function orderByTracking(tracking: string, email: string): Promise<string | null> {
  const rows = await execKw<{ origin: string | false; sale_id: Many2One }[]>(
    "stock.picking", "search_read",
    [[["carrier_tracking_ref", "=", tracking], ["partner_id.email", "=ilike", email]]],
    { fields: ["origin", "sale_id"], limit: 3 },
  );
  const r = rows[0];
  if (!r) return null;
  return m2oName(r.sale_id) ?? (r.origin ? String(r.origin) : null);
}

// Identifier shapes, matched against the customer's text.
const INVOICE_RE = /[Α-Ω]{2,4}\/\d{2,4}\/-?\d+/u; // ΑΛΠ/2026/-16839, ΤΔΑ/2026/123
const PICKING_RE = /[A-Z]{2,4}\/(?:OUT|IN|INT)\/\d+/u; // LGK/OUT/49573
const TRACKING_RE = /(?<![\d.])\d{9,}(?![\d.])/; // standalone ≥9-digit run (order numbers are 4–7)

/**
 * Scans free text for a non-order identifier (invoice / warehouse-move / tracking)
 * and resolves it to the real order reference via Odoo, scoped to `email`. Tries
 * the most specific shapes first. Returns null when nothing matches or resolves.
 */
export async function resolveOrderFromIdentifiers(text: string, email: string): Promise<string | null> {
  if (!text || !email) return null;
  try {
    const invoice = text.match(INVOICE_RE)?.[0];
    if (invoice) {
      const o = await orderByInvoice(invoice, email);
      if (o) return o;
    }
    const picking = text.match(PICKING_RE)?.[0];
    if (picking) {
      const o = await orderByPickingName(picking, email);
      if (o) return o;
    }
    const tracking = text.match(TRACKING_RE)?.[0];
    if (tracking) {
      const o = await orderByTracking(tracking, email);
      if (o) return o;
    }
    return null;
  } catch {
    log.error("odoo_identifier_lookup_failed", {});
    return null;
  }
}
