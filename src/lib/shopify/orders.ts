import { shopifyGraphQL } from "./client";

export interface ShopifyOrderSummary {
  name: string;
  createdAt: string;
  fulfillmentStatus: string;
  financialStatus: string;
  total: string;
  currency: string;
  paymentMethod?: string | null;
  trackings: { number?: string | null; company?: string | null; url?: string | null }[];
  lineItems: { title: string; quantity: number }[];
  shippingCity?: string | null;
}

interface OrderNode {
  name: string;
  createdAt: string;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  transactions: { gateway: string | null; kind: string; status: string }[];
  fulfillments: { trackingInfo: { number?: string; company?: string; url?: string }[] }[];
  lineItems: { edges: { node: { title: string; quantity: number } }[] };
  shippingAddress?: { city?: string | null } | null;
}

const ORDER_QUERY = `query($q: String!) {
  orders(first: 1, query: $q) {
    edges { node {
      name createdAt displayFulfillmentStatus displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      transactions(first: 50) { gateway kind status }
      fulfillments { trackingInfo { number company url } }
      lineItems(first: 25) { edges { node { title quantity } } }
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

/** Looks up a single order by its name/number (e.g. "1023" or "#1023"). */
export async function getOrderByName(
  orderNumber: string,
): Promise<ShopifyOrderSummary | null> {
  const num = orderNumber.replace(/^#/, "").trim();
  if (!num) return null;

  const data = await shopifyGraphQL<{ orders: { edges: { node: OrderNode }[] } }>(
    ORDER_QUERY,
    { q: `name:${num}` },
  );
  const node = data.orders.edges[0]?.node;
  if (!node) return null;

  return {
    name: node.name,
    createdAt: node.createdAt,
    fulfillmentStatus: node.displayFulfillmentStatus,
    financialStatus: node.displayFinancialStatus,
    total: node.totalPriceSet.shopMoney.amount,
    currency: node.totalPriceSet.shopMoney.currencyCode,
    paymentMethod: formatPaymentMethod(node.transactions ?? []),
    trackings: node.fulfillments.flatMap((f) => f.trackingInfo ?? []),
    lineItems: node.lineItems.edges.map((e) => e.node),
    shippingCity: node.shippingAddress?.city ?? null,
  };
}
