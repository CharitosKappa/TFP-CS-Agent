import { fmtDate } from "../util/date";
import { log, errInfo } from "../observability/logger";
import { getCustomerByEmail, type ShopifyCustomerSummary } from "./customers";
import {
  getDiscountByCodeWithLegacyFallback,
  type ShopifyDiscountSummary,
} from "./discounts";
import { getOrderByName, type ShopifyOrderSummary } from "./orders";
import { getProductByHandle, type ShopifyProductSummary } from "./products";

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

/** ENDEIKTIKΟΙ (estimate) fulfill/delivery times from Shopify shipping settings. */
function formatDeliveryEstimate(
  est: NonNullable<ShopifyOrderSummary["deliveryEstimate"]>,
): string {
  const parts: string[] = [];
  if (est.fulfillBy) parts.push(`αποστολή έως ${fmtDate(est.fulfillBy)}`);
  const min = est.minDelivery ? fmtDate(est.minDelivery) : null;
  const max = est.maxDelivery ? fmtDate(est.maxDelivery) : null;
  if (min || max) {
    const window = min && max && min !== max ? `${min} – ${max}` : (max ?? min);
    parts.push(`εκτιμώμενη παράδοση ${window}`);
  }
  return parts.join(" · ");
}

function formatOrder(o: ShopifyOrderSummary): string {
  const items = o.lineItems
    .map((li) => `${li.quantity}× ${li.title}${li.variantTitle ? ` (${li.variantTitle})` : ""}`)
    .join(", ");
  const tracking = o.trackings
    .filter((t) => t.number || t.url)
    .map((t) => [t.company, t.number, t.url].filter(Boolean).join(" "))
    .join(" | ");
  // Estimates matter while the order is still to ship; once there's tracking,
  // that's the real signal, so don't clutter the block with both.
  const estimate =
    o.deliveryEstimate && !tracking ? formatDeliveryEstimate(o.deliveryEstimate) : "";
  return [
    `Παραγγελία ${o.name} (${fmtDate(o.createdAt)})`,
    `- Εκτέλεση: ${o.fulfillmentStatus} | Κατάσταση πληρωμής: ${o.financialStatus}`,
    o.paymentMethod ? `- Τρόπος πληρωμής: ${o.paymentMethod}` : "",
    `- Σύνολο: ${o.total} ${o.currency}`,
    o.shippingMethod ? `- Τρόπος αποστολής (courier): ${o.shippingMethod}` : "",
    o.shippingCity ? `- Αποστολή προς: ${o.shippingCity}` : "",
    items ? `- Είδη: ${items}` : "",
    tracking ? `- Tracking: ${tracking}` : "",
    estimate ? `- Εκτιμώμενοι χρόνοι (ενδεικτικοί, όχι εγγύηση): ${estimate}` : "",
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

function formatProduct(p: ShopifyProductSummary): string {
  // Fit Advice drives size guidance (e.g. "true to size" → for a half/between size,
  // recommend the larger one — see knowledge/60-products-sizing.md).
  return [
    `Προϊόν: ${p.title}`,
    p.fitAdvice ? `- Fit Advice (εφαρμογή): ${p.fitAdvice}` : "",
    p.fitAndSizing ? `- Οδηγίες μεγέθους/εφαρμογής: ${p.fitAndSizing}` : "",
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
  /** Product handles from links in the customer's message (for fit/size advice). */
  productHandles?: string[];
}): Promise<string | undefined> {
  const parts: string[] = [];
  try {
    let orderAdded = false;
    if (input.orderNumber) {
      const order = await getOrderByName(input.orderNumber);
      if (order) {
        parts.push(formatOrder(order));
        orderAdded = true;
      }
    }
    if (input.customerEmail) {
      const customer = await getCustomerByEmail(input.customerEmail);
      if (customer) {
        parts.push(formatCustomer(customer));
        // No order number cited? Surface the customer's most recent order in full
        // (status, tracking, delivery estimate) — most "where's my order?" emails
        // don't include a number.
        if (!orderAdded && customer.recentOrders[0]) {
          const latest = await getOrderByName(customer.recentOrders[0].name).catch(() => null);
          if (latest) parts.push(formatOrder(latest));
        }
      }
    }
    if (input.couponCode) {
      // Modern code discounts, then (if not found) legacy price-rule codes —
      // each isolated so one failing (e.g. missing scope) doesn't block the other.
      const discount = await getDiscountByCodeWithLegacyFallback(input.couponCode);
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
    // Products the customer linked to (fit/size questions) — surface each product's
    // Fit Advice so the reply can advise on sizing from real data. Isolated per
    // handle so one failing lookup doesn't block the rest.
    if (input.productHandles?.length) {
      const products = await Promise.all(
        input.productHandles
          .slice(0, 3)
          .map((h) => getProductByHandle(h).catch(() => null)),
      );
      for (const p of products) {
        if (p) parts.push(formatProduct(p));
      }
    }
  } catch (e) {
    log.error("shopify_context_failed", errInfo(e));
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
