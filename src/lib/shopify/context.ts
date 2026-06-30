import type { Intent } from "../agent/types";
import { getCustomerByEmail, type ShopifyCustomerSummary } from "./customers";
import {
  getDiscountByCode,
  getLegacyDiscountByCode,
  type ShopifyDiscountSummary,
} from "./discounts";
import { getOrderByName, type ShopifyOrderSummary } from "./orders";

export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function formatDiscount(d: ShopifyDiscountSummary): string {
  const status =
    d.status === "ACTIVE"
      ? "ενεργός"
      : d.status === "EXPIRED"
        ? "έληξε"
        : d.status === "SCHEDULED"
          ? "προγραμματισμένος (δεν ισχύει ακόμη)"
          : d.status;
  return [
    `Κωδικός έκπτωσης "${d.code}": ${status}`,
    d.title && d.title !== d.code ? `- Τίτλος: ${d.title}` : "",
    d.summary ? `- Όροι: ${d.summary}` : "",
    d.endsAt ? `- Λήξη: ${fmtDate(d.endsAt)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatOrder(o: ShopifyOrderSummary): string {
  const items = o.lineItems.map((li) => `${li.quantity}× ${li.title}`).join(", ");
  const tracking = o.trackings
    .filter((t) => t.number || t.url)
    .map((t) => [t.company, t.number, t.url].filter(Boolean).join(" "))
    .join(" | ");
  return [
    `Παραγγελία ${o.name} (${fmtDate(o.createdAt)})`,
    `- Εκτέλεση: ${o.fulfillmentStatus} | Κατάσταση πληρωμής: ${o.financialStatus}`,
    o.paymentMethod ? `- Τρόπος πληρωμής: ${o.paymentMethod}` : "",
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
  // Store credit is a BALANCE on the account used at checkout — not a code. Show
  // it so the agent answers store-credit questions from real data, not guesses.
  const storeCredit = c.storeCredit.map((b) => `${b.amount} ${b.currency}`).join(", ");
  return [
    `Πελάτης: ${c.name} <${c.email}>`,
    `- Παραγγελίες: ${c.numberOfOrders} | Σύνολο δαπανών: ${c.amountSpent} ${c.currency}`,
    storeCredit
      ? `- Store Credit (πιστωτικό υπόλοιπο, διαθέσιμο στο checkout μετά από σύνδεση): ${storeCredit}`
      : "",
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
  couponCode?: string;
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
    if (input.couponCode) {
      // Check both discount systems: modern code discounts, then (if not found)
      // legacy price-rule codes. Each lookup is isolated so one failing (e.g.
      // missing scope) doesn't block the other.
      const lookup = async (
        fn: (c: string) => Promise<ShopifyDiscountSummary | null>,
      ): Promise<ShopifyDiscountSummary | null> => {
        try {
          return await fn(input.couponCode as string);
        } catch (e) {
          console.error("discount lookup failed:", e);
          return null;
        }
      };
      const discount =
        (await lookup(getDiscountByCode)) ?? (await lookup(getLegacyDiscountByCode));
      parts.push(
        discount
          ? formatDiscount(discount)
          : `Κωδικός έκπτωσης "${input.couponCode}": δεν επιστράφηκε από το Shopify API. ` +
            `Αυτό ΔΕΝ σημαίνει απαραίτητα ότι δεν υπάρχει — μπορεί να ισχύει μόνο για ` +
            `συγκεκριμένα προϊόντα/συλλογές/αγορές ή να έχει δημιουργηθεί από εξωτερική ` +
            `εφαρμογή (affiliate/influencer) που δεν είναι ορατή εδώ. ΜΗΝ πεις στον πελάτη ` +
            `ότι ο κωδικός δεν υπάρχει· εξήγησε ευγενικά ότι ένας κωδικός συχνά ισχύει μόνο ` +
            `σε επιλεγμένα προϊόντα/για περιορισμένο διάστημα/με ελάχιστη αξία, ζήτησε τον ` +
            `σύνδεσμο του προϊόντος και την πηγή του κωδικού, και πρότεινε έλεγχο από συνάδελφο.`,
      );
    }
  } catch (e) {
    console.error("shopify lookup failed:", e);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
