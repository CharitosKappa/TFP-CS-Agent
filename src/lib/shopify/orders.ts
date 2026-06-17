import { shopifyGraphQL } from "./client";

export interface ShopifyOrderSummary {
  name: string;
  createdAt: string;
  fulfillmentStatus: string;
  financialStatus: string;
  total: string;
  currency: string;
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
  fulfillments: { trackingInfo: { number?: string; company?: string; url?: string }[] }[];
  lineItems: { edges: { node: { title: string; quantity: number } }[] };
  shippingAddress?: { city?: string | null } | null;
}

const ORDER_QUERY = `query($q: String!) {
  orders(first: 1, query: $q) {
    edges { node {
      name createdAt displayFulfillmentStatus displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      fulfillments { trackingInfo { number company url } }
      lineItems(first: 25) { edges { node { title quantity } } }
      shippingAddress { city }
    } }
  }
}`;

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
    trackings: node.fulfillments.flatMap((f) => f.trackingInfo ?? []),
    lineItems: node.lineItems.edges.map((e) => e.node),
    shippingCity: node.shippingAddress?.city ?? null,
  };
}
