import { fmtDate } from "../util/date";
import { log, errInfo } from "../observability/logger";
import { getCustomerByEmail, type ShopifyCustomerSummary } from "./customers";
import {
  getDiscountByCodeWithLegacyFallback,
  type ShopifyDiscountSummary,
} from "./discounts";
import { getOrderByName, type ShopifyOrderSummary } from "./orders";
import { findAbandonedCheckoutByEmail } from "./checkouts";
import { getSizeAvailabilityBySku } from "../odoo/stock";
import { catalogSizeFilterUrl, collectionUrl, colourSiblingsWithSize, getProductByHandle, getProductBySku, inferCategoryCollection, productUrl, searchProductHandlesByName, sizeFilterUrl, storefrontBase, type ShopifyProductSummary } from "./products";

// How many of a customer's most recent orders to expand in full (items, courier,
// tracking, estimate) when the message cites no order number — enough to cover a
// customer juggling several concurrent orders, bounded for prompt cost. Older
// orders still appear as one-line entries in the customer block (getCustomerByEmail).
const RECENT_ORDERS_TO_SURFACE = 5;

function formatDiscount(d: ShopifyDiscountSummary, base: string): string {
  const status =
    d.status === "ACTIVE"
      ? "ενεργός"
      : d.status === "EXPIRED"
        ? "έληξε"
        : d.status === "SCHEDULED"
          ? "προγραμματισμένος (δεν ισχύει ακόμη)"
          : d.status;
  // The SPECIFIC eligible collections/products, named + linked, so the reply can
  // tell the customer exactly where the code applies instead of "selected items".
  const targets = [
    ...(d.appliesTo?.collections ?? []).map((c) => `  • Συλλογή «${c.title}»: ${collectionUrl(c.handle, base)}`),
    ...(d.appliesTo?.products ?? []).map((p) => `  • Προϊόν «${p.title}»: ${productUrl(p.handle, base)}`),
  ];
  return [
    `Κωδικός έκπτωσης "${d.code}": ${status}`,
    d.title && d.title !== d.code ? `- Τίτλος: ${d.title}` : "",
    d.summary ? `- Όροι: ${d.summary}` : "",
    d.endsAt ? `- Λήξη: ${fmtDate(d.endsAt)}` : "",
    targets.length
      ? `- ΙΣΧΥΕΙ ΓΙΑ ΤΑ ΕΞΗΣ (ανάφερέ τα ΟΝΟΜΑΣΤΙΚΑ στον πελάτη + δώσε τον σύνδεσμο):\n${targets.join("\n")}`
      : "",
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
    .map((li) => `${li.quantity}× ${li.title}${li.variantTitle ? ` (${li.variantTitle})` : ""}${li.sku ? ` (SKU: ${li.sku})` : ""}`)
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
    `Προϊόν: ${p.title}${p.colorSku ? ` (SKU: ${p.colorSku})` : ""}`,
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
// UK→EU shoe-size map — the storefront's UK selector values against our EU
// catalog sizes. Lets a size expressed in UK terms ("size 4", "UK 5.5") resolve
// to the EU size we actually stock. (EU and UK ranges don't overlap, so mapping
// UK tokens never collides with a real EU size.)
const UK_TO_EU: Record<string, string> = {
  "3.5": "36", "4": "37", "5": "38", "5.5": "39", "6.5": "40", "7.5": "41",
};

/** EU catalog sizes a raw asked-size string could mean (handles "4/37", "UK 4", "37"). */
function euSizeCandidates(asked: string): string[] {
  const out = new Set<string>();
  for (const t of asked.match(/\d+(?:\.\d+)?/g) ?? []) {
    out.add(t); // may already be an EU size
    if (UK_TO_EU[t]) out.add(UK_TO_EU[t]); // …or a UK size → its EU equivalent
  }
  return [...out];
}

async function productBlock(p: ShopifyProductSummary, askedSize: string | undefined, base: string): Promise<string> {
  let block = formatProduct(p);
  // Match the asked size against the catalog's EU sizes, accepting dual/regional
  // forms ("4/37") and bare UK sizes ("4" → EU 37) — a strict equality check
  // would miss a sold-out size and never surface its colour-sibling alternative.
  const candidates = askedSize ? euSizeCandidates(askedSize) : [];
  const askedEntry = candidates.length ? p.sizes.find((s) => candidates.includes(s.size)) : undefined;
  if (askedEntry && !askedEntry.available) {
    const size = askedEntry.size; // normalized EU catalog size, e.g. "37"
    // Odoo restock signal for THIS size (best-effort): sold out on Shopify/LGK but
    // physically present in an incoming TFP location → "expected back shortly".
    let restockNote = "";
    if (p.colorSku) {
      const inSize = (await getSizeAvailabilityBySku(p.colorSku).catch(() => [])).find((a) => a.size === size);
      if (inSize && inSize.incoming > 0) {
        restockNote = `\n- ΑΝΑΜΕΝΕΤΑΙ ΣΥΝΤΟΜΑ ξανά διαθέσιμο στο μέγεθος ${size} (υπάρχει απόθεμα καθ' οδόν προς την αποθήκη πώλησης). Πες το ως προσδοκία, ΧΩΡΙΣ ημερομηνία/εγγύηση.`;
      }
    }
    const alts: string[] = [];
    if (p.master) {
      const siblings = (await colourSiblingsWithSize(p.master, size).catch(() => []))
        .filter((s) => s.handle !== p.handle);
      // Each sibling WITH its product link — the customer should be able to click
      // straight through to the alternative colour in their size.
      if (siblings.length) {
        alts.push(
          `- Ίδιο μοντέλο σε ΑΛΛΟ χρώμα με μέγεθος ${size} διαθέσιμο (δώσε τους συνδέσμους ΚΑΙ τον SKU):\n` +
            siblings.map((s) => `  • ${s.title}${s.colorSku ? ` (SKU: ${s.colorSku})` : ""}: ${productUrl(s.handle, base)}`).join("\n"),
        );
      }
    }
    // ALWAYS end with a general "what's available in your size" link — category-
    // filtered when we can pin the category, else the whole catalog in that size.
    alts.push(
      p.categoryCollectionHandle
        ? `- Και γενικός σύνδεσμος με όλα τα διαθέσιμα «${p.categoryName ?? "προϊόντα"}» στο μέγεθος ${size}: ${sizeFilterUrl(p.categoryCollectionHandle, size, base)}`
        : `- Και γενικός σύνδεσμος με όλα τα διαθέσιμα προϊόντα στο μέγεθος ${size}: ${catalogSizeFilterUrl(size, base)}`,
    );
    block += `\n- ΤΟ ΜΕΓΕΘΟΣ ${size} ΕΙΝΑΙ ΕΞΑΝΤΛΗΜΕΝΟ σε αυτό το προϊόν.${restockNote}\n  Πρότεινε επίσης εναλλακτικές:\n${alts.join("\n")}`;
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
  /**
   * Coupon codes the customer put in front of us (typed OR quoted from the offer
   * they're replying to). ONLY these are looked up — never other/active codes, so
   * we can't leak someone else's or an upcoming promo. See extractCouponCodes.
   */
  couponCandidates?: string[];
  /** Product handles from links in the customer's message (for fit/size advice). */
  productHandles?: string[];
  /** SKUs the customer quoted (e.g. subject "SKU: 26012175") — resolved to products. */
  productSkus?: string[];
  /** Shoe size the customer asked about — drives the sold-out → alternatives block. */
  productSize?: string;
  /** Product name the customer typed (no link) — used to infer a category size link. */
  productName?: string;
  /**
   * When true AND no order is found for the customer, look up a recent INCOMPLETE
   * checkout (abandoned cart) for their email — for "I ordered but got no
   * confirmation email" cases, so the reply can hand them the recovery link.
   */
  checkAbandonedCheckout?: boolean;
}): Promise<string | undefined> {
  const parts: string[] = [];
  try {
    // The customer's orders shown in this context — a size/fit question without a
    // product link resolves its product from these line items (see below).
    const surfacedOrders: ShopifyOrderSummary[] = [];
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
      }
    }
    let customerCountry: string | null = null;
    if (input.customerEmail) {
      const customer = await getCustomerByEmail(input.customerEmail);
      if (customer) {
        parts.push(formatCustomer(customer));
        customerCountry = customer.countryCode ?? null;
        // Surface the customer's recent orders in FULL (items, courier, tracking) —
        // not just the cited one. A customer often asks about one order but a
        // RELATED one matters too: e.g. they ask how to exchange order A while
        // having already placed a replacement order B — the reply must see B's
        // contents to acknowledge it instead of pushing a sold-out alternative.
        // Skip any order already surfaced (the cited one), bounded for prompt cost.
        const already = new Set(surfacedOrders.map((o) => o.name.replace(/^#/, "")));
        const toExpand = customer.recentOrders
          .filter((o) => !already.has(o.name.replace(/^#/, "")))
          .slice(0, RECENT_ORDERS_TO_SURFACE);
        if (toExpand.length) {
          const recent = await Promise.all(
            toExpand.map((o) => getOrderByName(o.name).catch(() => null)),
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
    // Storefront locale for customer-facing links, by MARKET: GR shipping country →
    // main domain (Greek); everyone else → /en-eu. Prefer the order's shipping
    // country, else the customer's default-address country. Defined here so the
    // coupon block below can build links to a code's eligible collections/products.
    const base = storefrontBase(surfacedOrders[0]?.shippingCountry ?? customerCountry);

    // Look up ONLY the code(s) the customer put in front of us (typed or quoted
    // from the offer they're replying to) — never other/active codes, so we can't
    // leak another customer's or an upcoming promo. Each lookup is isolated.
    const couponCodes = Array.from(
      new Set([...(input.couponCode ? [input.couponCode] : []), ...(input.couponCandidates ?? [])]
        .map((c) => c.trim()).filter(Boolean)),
    ).slice(0, 5);
    if (couponCodes.length) {
      const found: string[] = [];
      for (const code of couponCodes) {
        const discount = await getDiscountByCodeWithLegacyFallback(code).catch(() => null);
        if (discount) found.push(formatDiscount(discount, base));
      }
      parts.push(
        found.length
          ? found.join("\n\n")
          : `Κωδικός έκπτωσης "${couponCodes[0]}": δεν επιστράφηκε από το Shopify API. ` +
            `Αυτό ΔΕΝ σημαίνει απαραίτητα ότι δεν υπάρχει — μπορεί να ισχύει μόνο για ` +
            `συγκεκριμένα προϊόντα/συλλογές/αγορές ή να έχει δημιουργηθεί από εξωτερική ` +
            `εφαρμογή (affiliate/influencer) που δεν είναι ορατή εδώ. ΜΗΝ πεις στον πελάτη ` +
            `ότι ο κωδικός δεν υπάρχει· εξήγησε ευγενικά ότι ένας κωδικός συχνά ισχύει μόνο ` +
            `σε επιλεγμένα προϊόντα/για περιορισμένο διάστημα/με ελάχιστη αξία, ζήτησε τον ` +
            `σύνδεσμο του προϊόντος και την πηγή του κωδικού, και πρότεινε έλεγχο από συνάδελφο.`,
      );
    }

    // No order found, but the customer says they ordered / got no confirmation →
    // look up their most recent INCOMPLETE checkout. If there is one, the order
    // never completed (hence no email); hand them the recovery link to finish the
    // SAME checkout instead of re-ordering. Email is matched exactly inside.
    if (input.checkAbandonedCheckout && input.customerEmail && surfacedOrders.length === 0) {
      const ac = await findAbandonedCheckoutByEmail(input.customerEmail).catch(() => null);
      if (ac) {
        const items = ac.items.map((i) => `${i.quantity}× ${i.title}`).join(", ");
        parts.push(
          [
            `ΗΜΙΤΕΛΕΣ CHECKOUT (η παραγγελία ΔΕΝ ολοκληρώθηκε — γι' αυτό δεν στάλθηκε email επιβεβαίωσης):`,
            `- Καλάθι: ${fmtDate(ac.createdAt)} · ${ac.total} ${ac.currency}`,
            items ? `- Είδη: ${items}` : "",
            `- ΣΥΝΔΕΣΜΟΣ ΟΛΟΚΛΗΡΩΣΗΣ (δώσ' τον στον πελάτη για να ολοκληρώσει την ΙΔΙΑ παραγγελία — ΟΧΙ νέα): ${ac.recoveryUrl}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }

    // Products the customer linked to (fit/size questions) — surface each product's
    // Fit Advice so the reply can advise on sizing from real data. Isolated per
    // handle so one failing lookup doesn't block the rest.
    let resolvedProduct = false;
    // Handles of product blocks already pushed — the three resolution paths
    // (links → name search → order items) overlap, so dedupe across them.
    const shownHandles = new Set<string>();
    // SKU is the most precise identifier the customer can give (often in the
    // subject, e.g. "SKU: 26012175") — resolve it FIRST, authoritative like a link.
    if (input.productSkus?.length) {
      const products = await Promise.all(
        input.productSkus.slice(0, 3).map((s) => getProductBySku(s).catch(() => null)),
      );
      for (const p of products) {
        if (!p || shownHandles.has(p.handle)) continue;
        resolvedProduct = true;
        shownHandles.add(p.handle);
        parts.push(await productBlock(p, input.productSize, base));
      }
    }
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
        parts.push(await productBlock(p, input.productSize, base));
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
            `Αν ΔΕΝ ταιριάζει με την περιγραφή του, αγνόησέ το και ζήτησε ευγενικά τον σύνδεσμο ή το SKU:\n${await productBlock(p, input.productSize, base)}`,
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
            `Αν ΔΕΝ ταιριάζει με το προϊόν που περιγράφει ο πελάτης, αγνόησέ το και ζήτησε ευγενικά τον σύνδεσμο ή το SKU:\n${await productBlock(p, input.productSize, base)}`,
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
        ? `- Σύνδεσμος διαθέσιμων «${cat.categoryName}» στο νούμερο ${size}: ${sizeFilterUrl(cat.collectionHandle, size, base)}`
        : `- Σύνδεσμος διαθέσιμων προϊόντων στο νούμερο ${size} (γενικός κατάλογος): ${catalogSizeFilterUrl(size, base)}`;
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
