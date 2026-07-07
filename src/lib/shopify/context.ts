import { fmtDate } from "../util/date";
import { log, errInfo } from "../observability/logger";
import { getCustomerByEmail, type ShopifyCustomerSummary } from "./customers";
import {
  getDiscountByCodeWithLegacyFallback,
  type ShopifyDiscountSummary,
} from "./discounts";
import { getOrderByName, type ShopifyOrderSummary } from "./orders";
import { catalogSizeFilterUrl, colourSiblingsWithSize, getProductByHandle, inferCategoryCollection, searchProductHandlesByName, sizeFilterUrl, type ShopifyProductSummary } from "./products";

// How many of a customer's most recent orders to expand in full (items, courier,
// tracking, estimate) when the message cites no order number — enough to cover a
// customer juggling several concurrent orders, bounded for prompt cost. Older
// orders still appear as one-line entries in the customer block (getCustomerByEmail).
const RECENT_ORDERS_TO_SURFACE = 5;

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
 * A product's prompt block; when the size the customer asked about is sold out
 * on this product, appends the two fallbacks — another colour of the same model
 * that has the size, and a category link filtered to available items in it.
 */
async function productBlock(p: ShopifyProductSummary, askedSize?: string): Promise<string> {
  let block = formatProduct(p);
  const askedEntry = askedSize ? p.sizes.find((s) => s.size === askedSize) : undefined;
  if (askedSize && askedEntry && !askedEntry.available) {
    const alts: string[] = [];
    if (p.master) {
      const siblings = (await colourSiblingsWithSize(p.master, askedSize).catch(() => []))
        .filter((s) => s.handle !== p.handle);
      if (siblings.length) alts.push(`- Ίδιο μοντέλο σε ΑΛΛΟ χρώμα με μέγεθος ${askedSize} διαθέσιμο: ${siblings.map((s) => s.title).join(", ")}`);
    }
    if (p.categoryCollectionHandle) {
      alts.push(`- Σύνδεσμος διαθέσιμων «${p.categoryName ?? "προϊόντων"}» στο μέγεθος ${askedSize}: ${sizeFilterUrl(p.categoryCollectionHandle, askedSize)}`);
    }
    if (alts.length) block += `\n- ΤΟ ΜΕΓΕΘΟΣ ${askedSize} ΕΙΝΑΙ ΕΞΑΝΤΛΗΜΕΝΟ σε αυτό το προϊόν. Πρότεινε:\n${alts.join("\n")}`;
  }
  return block;
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
    // The customer's orders shown in this context — a size/fit question without a
    // product link resolves its product from these line items (see below).
    const surfacedOrders: ShopifyOrderSummary[] = [];
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
        surfacedOrders.push(order);
        orderAdded = true;
      }
    }
    if (input.customerEmail) {
      const customer = await getCustomerByEmail(input.customerEmail);
      if (customer) {
        parts.push(formatCustomer(customer));
        // No order number cited? Surface the customer's recent orders in FULL —
        // not just the latest. A customer with several open orders often asks
        // about a specific one by its CONTENTS ("my other order of three shoes"),
        // so only expanding the newest left the draft blind to it — it couldn't
        // name the order, its courier, or its tracking. Expanding the recent few
        // lets the reply match the right order and quote its tracking + courier.
        if (!orderAdded && customer.recentOrders.length) {
          const recent = await Promise.all(
            customer.recentOrders
              .slice(0, RECENT_ORDERS_TO_SURFACE)
              .map((o) => getOrderByName(o.name).catch(() => null)),
          );
          for (const order of recent) {
            if (order) {
              parts.push(formatOrder(order));
              surfacedOrders.push(order);
            }
          }
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
    // Handles of product blocks already pushed — the three resolution paths
    // (links → name search → order items) overlap, so dedupe across them.
    const shownHandles = new Set<string>();
    if (input.productHandles?.length) {
      const products = await Promise.all(
        input.productHandles
          .slice(0, 3)
          .map((h) => getProductByHandle(h).catch(() => null)),
      );
      for (const p of products) {
        if (!p) continue;
        resolvedProduct = true;
        shownHandles.add(p.handle);
        parts.push(await productBlock(p, input.productSize));
      }
    }
    // The customer explicitly LINKED products — those are authoritative for what
    // they're asking about, so the search/order paths below stay off in that case.
    const resolvedFromLinks = resolvedProduct;
    // Customer NAMED a product without a link — usually in the storefront
    // language they browsed (e.g. «Σουέντ σανδάλια με velcro - Μαύρο», the Greek
    // TRANSLATION of an English admin title), which the Admin API title query
    // can't match. The storefront's predictive search indexes the localized
    // content, so it resolves the typed name (any storefront language) to handles.
    if (!resolvedProduct && input.productName) {
      const found = await searchProductHandlesByName(input.productName);
      for (const h of found) {
        if (shownHandles.has(h)) continue;
        const p = await getProductByHandle(h).catch(() => null);
        if (!p) continue;
        resolvedProduct = true;
        shownHandles.add(p.handle);
        parts.push(
          `Πιθανό προϊόν που περιγράφει ο πελάτης (ταυτοποιήθηκε με αναζήτηση του ονόματος στο eshop). ` +
            `Αν ΔΕΝ ταιριάζει με την περιγραφή του, αγνόησέ το και ζήτησε ευγενικά τον σύνδεσμο ή το SKU:\n${await productBlock(p, input.productSize)}`,
        );
      }
    }
    // Product/size question with no link, and the customer's order is already on
    // screen: the product they mean is often one of the order's own line items
    // ("έκανα πριν λίγο παραγγελία το μοντέλο Χ — πώς πάει το 38;"). Resolve those
    // too (deduped against the name-search result above) so the reply answers from
    // real data — instead of the ask-for-a-link fallback below firing and
    // overriding order data the model can already see.
    if (!resolvedFromLinks && (input.productSize || input.productName) && surfacedOrders.length) {
      const handles = [
        ...new Set(
          surfacedOrders
            .flatMap((o) => o.lineItems.map((li) => li.productHandle))
            .filter((h): h is string => Boolean(h)),
        ),
      ]
        .filter((h) => !shownHandles.has(h))
        .slice(0, 3);
      const products = await Promise.all(handles.map((h) => getProductByHandle(h).catch(() => null)));
      for (const p of products) {
        if (!p) continue;
        resolvedProduct = true;
        shownHandles.add(p.handle);
        parts.push(
          `Προϊόν από τα ΕΙΔΗ ΤΗΣ ΠΑΡΑΓΓΕΛΙΑΣ του πελάτη (δεν έδωσε link — ταυτοποιήθηκε από την παραγγελία του). ` +
            `Αν ΔΕΝ ταιριάζει με το προϊόν που περιγράφει ο πελάτης, αγνόησέ το και ζήτησε ευγενικά τον σύνδεσμο ή το SKU:\n${await productBlock(p, input.productSize)}`,
        );
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
