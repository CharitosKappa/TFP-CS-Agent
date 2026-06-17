import type { Intent } from "../agent/types";
import { getCustomerByEmail, type ShopifyCustomerSummary } from "./customers";
import { getOrderByName, type ShopifyOrderSummary } from "./orders";

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function formatOrder(o: ShopifyOrderSummary): string {
  const items = o.lineItems.map((li) => `${li.quantity}× ${li.title}`).join(", ");
  const tracking = o.trackings
    .filter((t) => t.number || t.url)
    .map((t) => [t.company, t.number, t.url].filter(Boolean).join(" "))
    .join(" | ");
  return [
    `Παραγγελία ${o.name} (${fmtDate(o.createdAt)})`,
    `- Εκτέλεση: ${o.fulfillmentStatus} | Πληρωμή: ${o.financialStatus}`,
    `- Σύνολο: ${o.total} ${o.currency}`,
    o.shippingCity ? `- Αποστολή προς: ${o.shippingCity}` : "",
    items ? `- Είδη: ${items}` : "",
    tracking ? `- Tracking: ${tracking}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCustomer(c: ShopifyCustomerSummary): string {
  const orders = c.recentOrders
    .map(
      (o) =>
        `${o.name} (${fmtDate(o.createdAt)}, ${o.fulfillmentStatus}/${o.financialStatus})`,
    )
    .join(", ");
  return [
    `Πελάτης: ${c.name} <${c.email}>`,
    `- Παραγγελίες: ${c.numberOfOrders} | Σύνολο δαπανών: ${c.amountSpent} ${c.currency}`,
    orders ? `- Πρόσφατες: ${orders}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Fetches the Shopify data relevant to a message (fresh, on-demand) and formats
 * it as a compact text block for the prompt. Best-effort: never throws — a
 * Shopify failure must not block drafting.
 */
export async function gatherShopifyContext(input: {
  orderNumber?: string;
  customerEmail?: string;
  intent?: Intent;
}): Promise<string | undefined> {
  const parts: string[] = [];
  try {
    if (input.orderNumber) {
      const order = await getOrderByName(input.orderNumber);
      if (order) parts.push(formatOrder(order));
    }
    if (input.customerEmail) {
      const customer = await getCustomerByEmail(input.customerEmail);
      if (customer) parts.push(formatCustomer(customer));
    }
  } catch (e) {
    console.error("shopify lookup failed:", e);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
