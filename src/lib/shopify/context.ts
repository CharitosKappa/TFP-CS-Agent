import { fmtDate } from "../util/date";
import { log, errInfo } from "../observability/logger";
import { getCustomerByEmail, type ShopifyCustomerSummary } from "./customers";
import {
  getDiscountByCodeWithLegacyFallback,
  type ShopifyDiscountSummary,
} from "./discounts";
import { getOrderByName, type ShopifyOrderSummary } from "./orders";
import { catalogSizeFilterUrl, colourSiblingsWithSize, getProductByHandle, inferCategoryCollection, sizeFilterUrl, type ShopifyProductSummary } from "./products";

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
  const inStock = p.sizes.filter((s) => s.available).map((s) => s.size);
  const soldOut = p.sizes.filter((s) => !s.available).map((s) => s.size);
  return [
    `Προϊόν: ${p.title}`,
    p.fitAdvice ? `- Fit Advice (εφαρμογή): ${p.fitAdvice}` : "",
    p.fitAndSizing ? `- Οδηγίες μεγέθους/εφαρμογής: ${p.fitAndSizing}` : "",
    p.sizes.length
      ? `- Διαθέσιμα μεγέθη: ${inStock.join(", ") || "κανένα"}${soldOut.length ? ` · εξαντλημένα: ${soldOut.join(", ")}` : ""}`
      : "",
    `- Notify-me (ειδοποίηση επαναδιαθεσιμότητας): ${p.notifyMeEnabled ? "ΕΝΕΡΓΟ — μπορείς να το προτείνεις" : "ΑΝΕΝΕΡΓΟ — ΜΗΝ προτείνεις «Notify me» γι' αυτό το προϊόν"}`,
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
  /** Shoe size the customer asked about — drives the sold-out → alternatives block. */
  productSize?: string;
  /** Product name the customer typed (no link) — used to infer a category size link. */
  productName?: string;
}): Promise<string | undefined> {
  const parts: string[] = [];
  try {
    let orderAdded = false;
    if (input.orderNumber) {
      const order = await getOrderByName(input.orderNumber);
      // Ownership: if the order carries an email that ISN'T the verified sender,
      // the number reached us wrong (misparse/typo/foreign) — showing the order
      // would leak another customer's data into this reply. Skip it; the sender's
      // own latest order still surfaces via the customer block below.
      const foreign = !!(
        order?.email && input.customerEmail &&
        order.email.toLowerCase() !== input.customerEmail.toLowerCase()
      );
      if (foreign) log.warn("shopify_order_owner_mismatch", {});
      if (order && !foreign) {
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
    let resolvedProduct = false;
    if (input.productHandles?.length) {
      const products = await Promise.all(
        input.productHandles
          .slice(0, 3)
          .map((h) => getProductByHandle(h).catch(() => null)),
      );
      for (const p of products) {
        if (!p) continue;
        resolvedProduct = true;
        let block = formatProduct(p);
        // Customer asked about a specific size that's sold out on THIS product →
        // give the reviewer the two fallbacks: another colour of the same model
        // that has the size, and a filtered link to available items in that size.
        const asked = input.productSize;
        const askedEntry = asked ? p.sizes.find((s) => s.size === asked) : undefined;
        if (asked && askedEntry && !askedEntry.available) {
          const alts: string[] = [];
          if (p.master) {
            const siblings = (await colourSiblingsWithSize(p.master, asked).catch(() => []))
              .filter((s) => s.handle !== p.handle);
            if (siblings.length) alts.push(`- Ίδιο μοντέλο σε ΑΛΛΟ χρώμα με μέγεθος ${asked} διαθέσιμο: ${siblings.map((s) => s.title).join(", ")}`);
          }
          if (p.categoryCollectionHandle) {
            alts.push(`- Σύνδεσμος διαθέσιμων «${p.categoryName ?? "προϊόντων"}» στο μέγεθος ${asked}: ${sizeFilterUrl(p.categoryCollectionHandle, asked)}`);
          }
          if (alts.length) block += `\n- ΤΟ ΜΕΓΕΘΟΣ ${asked} ΕΙΝΑΙ ΕΞΑΝΤΛΗΜΕΝΟ σε αυτό το προϊόν. Πρότεινε:\n${alts.join("\n")}`;
        }
        parts.push(block);
      }
    }
    // Size question, but we couldn't resolve the exact product (named without a
    // link, or ambiguous). We can't state per-size stock — but we CAN point the
    // customer to what's available in their size: the product's CATEGORY when we
    // can infer it from the name, else the full catalog. Both filtered to the size.
    if (input.productSize && !resolvedProduct) {
      const size = input.productSize;
      const cat = input.productName
        ? await inferCategoryCollection(input.productName).catch(() => null)
        : null;
      const link = cat
        ? `- Σύνδεσμος διαθέσιμων «${cat.categoryName}» στο νούμερο ${size}: ${sizeFilterUrl(cat.collectionHandle, size)}`
        : `- Σύνδεσμος διαθέσιμων προϊόντων στο νούμερο ${size} (γενικός κατάλογος): ${catalogSizeFilterUrl(size)}`;
      parts.push(
        `ΤΟ ΣΥΓΚΕΚΡΙΜΕΝΟ ΠΡΟΪΟΝ ΔΕΝ ΤΑΥΤΟΠΟΙΗΘΗΚΕ (δόθηκε μόνο όνομα, χωρίς σύνδεσμο). ` +
          `Ζήτησε ευγενικά τον σύνδεσμο ή το SKU, ΚΑΙ δώσε τον παρακάτω σύνδεσμο με τα διαθέσιμα στο νούμερο ${size}:\n${link}`,
      );
    }
  } catch (e) {
    log.error("shopify_context_failed", errInfo(e));
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
