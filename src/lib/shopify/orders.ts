import { log, errInfo } from "../observability/logger";
import { shopifyGraphQL } from "./client";
import { orderNameQuery } from "./search";

export interface ShopifyOrderSummary {
  name: string;
  /** The email on the order — used to verify the order belongs to the sender. */
  email?: string | null;
  createdAt: string;
  fulfillmentStatus: string;
  financialStatus: string;
  total: string;
  currency: string;
  paymentMethod?: string | null;
  /** The shipping method/courier the customer chose, e.g. "ACS GR", "Box Now". */
  shippingMethod?: string | null;
  trackings: { number?: string | null; company?: string | null; url?: string | null }[];
  /** productHandle lets a size/fit question resolve the product straight from the order. */
  lineItems: { title: string; quantity: number; variantTitle?: string | null; productHandle?: string | null; sku?: string | null }[];
  shippingCity?: string | null;
  /**
   * Shopify's fulfillment/delivery estimates (ISO datetimes) for an unfulfilled
   * order: when it must be handed to the carrier and the expected delivery
   * window. These are ESTIMATES from shipping settings, not guarantees.
   */
  deliveryEstimate?: {
    fulfillBy: string | null;
    minDelivery: string | null;
    maxDelivery: string | null;
  } | null;
}

interface OrderNode {
  name: string;
  email: string | null;
  createdAt: string;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  shippingLine?: { title: string | null } | null;
  transactions: { gateway: string | null; kind: string; status: string }[];
  fulfillments: { trackingInfo: { number?: string; company?: string; url?: string }[] }[];
  lineItems: { edges: { node: { title: string; quantity: number; variantTitle?: string | null; sku?: string | null; product?: { handle: string } | null } }[] };
  shippingAddress?: { city?: string | null } | null;
}

const ORDER_QUERY = `query($q: String!) {
  orders(first: 1, query: $q) {
    edges { node {
      name email createdAt displayFulfillmentStatus displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      shippingLine { title }
      transactions(first: 50) { gateway kind status }
      fulfillments { trackingInfo { number company url } }
      lineItems(first: 25) { edges { node { title quantity variantTitle sku product { handle } } } }
      shippingAddress { city }
    } }
  }
}`;

// Friendlier labels for Shopify's internal gateway slugs. Branded gateways
// (Viva.com, Klarna, PayPal…) already read well and pass through unchanged.
const GATEWAY_LABELS: Record<string, string> = {
  shopify_payments: "Κάρτα (Shopify Payments)",
  shopify_store_credit: "Store Credit",
  "cash on delivery (cod)": "Αντικαταβολή",
  manual: "Χειροκίνητη πληρωμή",
  gift_card: "Δωροκάρτα",
  bogus: "Δοκιμαστική πληρωμή (bogus)",
};

// Transaction kinds that represent the customer paying (vs refunds/voids), and
// the statuses that count as a real, non-failed payment.
const PAYMENT_KINDS = new Set(["SALE", "CAPTURE", "AUTHORIZATION"]);
// SUCCESS = paid; PENDING = legitimately unpaid-for-now (cash on delivery). We
// deliberately ignore FAILURE/ERROR (declined attempts) and any in-progress or
// unknown states, so only the actual successful payment method(s) show.
const PAID_STATUSES = new Set(["SUCCESS", "PENDING"]);

/**
 * The payment method(s) the customer actually paid with, derived from the order's
 * transactions — not `paymentGatewayNames`, which also lists gateways from failed
 * attempts (e.g. several declined Klarna tries before paying by card). A gateway
 * counts only if it has a successful (or COD-pending) payment transaction.
 * Distinct, in order of first appearance, joined with " + " for split payments.
 */
function formatPaymentMethod(
  transactions: { gateway: string | null; kind: string; status: string }[],
): string | null {
  const methods: string[] = [];
  for (const t of transactions) {
    if (!t.gateway || !PAYMENT_KINDS.has(t.kind) || !PAID_STATUSES.has(t.status)) continue;
    const label = GATEWAY_LABELS[t.gateway.toLowerCase()] ?? t.gateway;
    if (!methods.includes(label)) methods.push(label);
  }
  return methods.length ? methods.join(" + ") : null;
}

// Delivery/fulfillment estimates live on fulfillmentOrders, behind their own
// scopes (read_merchant_managed_fulfillment_orders, …). Queried separately and
// isolated so a missing scope or error degrades to "no estimate shown" rather
// than wiping the whole order lookup.
const DELIVERY_ESTIMATE_QUERY = `query($q: String!) {
  orders(first: 1, query: $q) {
    edges { node { fulfillmentOrders(first: 5) { edges { node {
      status fulfillBy
      deliveryMethod { minDeliveryDateTime maxDeliveryDateTime }
    } } } } }
  }
}`;

/** Fulfillment/delivery estimate for an order; null on no data, missing scope, or error. */
async function getDeliveryEstimateByOrderName(
  num: string,
): Promise<ShopifyOrderSummary["deliveryEstimate"]> {
  try {
    const data = await shopifyGraphQL<{
      orders: {
        edges: { node: { fulfillmentOrders: { edges: { node: {
          status: string;
          fulfillBy: string | null;
          deliveryMethod: { minDeliveryDateTime: string | null; maxDeliveryDateTime: string | null } | null;
        } }[] } } }[];
      };
    }>(DELIVERY_ESTIMATE_QUERY, { q: `name:${num}` });
    const fos = data.orders.edges[0]?.node.fulfillmentOrders.edges.map((e) => e.node) ?? [];
    const hasEstimate = (f: (typeof fos)[number]) => Boolean(f.fulfillBy || f.deliveryMethod);
    // Prefer an OPEN (still-to-ship) fulfillment order; else any with an estimate.
    const fo = fos.find((f) => f.status === "OPEN" && hasEstimate(f)) ?? fos.find(hasEstimate);
    if (!fo) return null;
    return {
      fulfillBy: fo.fulfillBy ?? null,
      minDelivery: fo.deliveryMethod?.minDeliveryDateTime ?? null,
      maxDelivery: fo.deliveryMethod?.maxDeliveryDateTime ?? null,
    };
  } catch (e) {
    log.error("shopify_delivery_estimate_lookup_failed", errInfo(e));
    return null;
  }
}

/**
 * Best-effort extraction of an order number from free text (message/thread), for
 * when the classifier didn't surface one — e.g. a follow-up ("cancel the order")
 * that no longer repeats the number, but our earlier replies/the thread do
 * ("order #50616" / "commande n° 50616"). Matches only order-flavoured contexts,
 * not any bare number.
 */
export function extractOrderNumber(text: string): string | undefined {
  const m = text.match(/(?:#|n[°o]\.?\s*|order\s+#?|commande\s+(?:n[°o]\.?\s*)?|παραγγελ\w*\s*#?)(\d{4,7})\b/i);
  return m?.[1];
}

// Identifiers customers routinely paste that are NOT the order number: RMA refs,
// Greek accounting-document series (ΑΛΠ/ΤΔΑ/ΤΠΥ/… receipts & invoices), and Odoo
// warehouse-move names (LGK/OUT/…). Their embedded digits must not be mistaken
// for an order number (e.g. "ΑΛΠ/2026/-16839" → a bogus order "16839").
const NON_ORDER_ID_RE: RegExp[] = [
  /RMA[\s#:-]*\d+/giu,
  /[Α-Ω]{2,4}\/\d{2,4}\/-?\d+/gu, // ΑΛΠ/2026/-16839
  /[A-Z]{2,4}\/(?:OUT|IN|INT)\/\d+/gu, // LGK/OUT/49573
];

/** Removes non-order identifier tokens (RMA/invoice/warehouse-move) from text. */
export function stripNonOrderIdentifiers(text: string): string {
  return NON_ORDER_ID_RE.reduce((s, re) => s.replace(re, " "), text);
}

const ORDER_TRACKING_SEARCH = `query($q: String!) {
  orders(first: 10, query: $q) {
    edges { node { name fulfillments { trackingInfo { number } } } }
  }
}`;

/**
 * Resolves a customer-provided value to a real order NAME (digits, no "#").
 * Accepts an order number directly, or a TRACKING number — customers often paste
 * the shipment/tracking number thinking it's the order number. If it isn't an
 * order name, we search and confirm it against orders' tracking numbers. Returns
 * null if it resolves to neither.
 */
export async function resolveOrderName(value: string): Promise<string | null> {
  const v = value.replace(/^#/, "").trim();
  if (!v) return null;
  if (await getOrderByName(v)) return v; // already a real order number
  try {
    const edges = (await shopifyGraphQL<{
      orders: { edges: { node: { name: string; fulfillments: { trackingInfo: { number: string | null }[] }[] } }[] };
    }>(ORDER_TRACKING_SEARCH, { q: v })).orders.edges;
    const match = edges.find((e) => e.node.fulfillments.some((f) => f.trackingInfo.some((t) => t.number === v)));
    return match ? match.node.name.replace(/^#/, "") : null;
  } catch {
    return null; // best-effort — a failed tracking lookup must not block drafting
  }
}

/** Looks up a single order by its name/number (e.g. "1023" or "#1023"). */
export async function getOrderByName(
  orderNumber: string,
): Promise<ShopifyOrderSummary | null> {
  const q = orderNameQuery(orderNumber);
  if (!q) return null;
  const num = orderNumber.replace(/^#/, "").trim(); // digits (validated by q)

  // The order and its delivery estimate are independent lookups keyed on the same
  // name — run them together. Trade-off: one wasted estimate query when the order
  // isn't found, for ~halved latency on the common found path.
  const [data, deliveryEstimate] = await Promise.all([
    shopifyGraphQL<{ orders: { edges: { node: OrderNode }[] } }>(ORDER_QUERY, { q }),
    getDeliveryEstimateByOrderName(num),
  ]);
  const node = data.orders.edges[0]?.node;
  if (!node) return null;

  return {
    name: node.name,
    email: node.email ?? null,
    createdAt: node.createdAt,
    fulfillmentStatus: node.displayFulfillmentStatus,
    financialStatus: node.displayFinancialStatus,
    total: node.totalPriceSet.shopMoney.amount,
    currency: node.totalPriceSet.shopMoney.currencyCode,
    paymentMethod: formatPaymentMethod(node.transactions ?? []),
    shippingMethod: node.shippingLine?.title ?? null,
    trackings: node.fulfillments.flatMap((f) => f.trackingInfo ?? []),
    lineItems: node.lineItems.edges.map((e) => ({
      title: e.node.title,
      quantity: e.node.quantity,
      variantTitle: e.node.variantTitle ?? null,
      productHandle: e.node.product?.handle ?? null,
      sku: e.node.sku ?? null,
    })),
    shippingCity: node.shippingAddress?.city ?? null,
    deliveryEstimate,
  };
}
