import { resilientFetch } from "../http/resilient";
import { shopifyGraphQL } from "./client";
import { handleQuery } from "./search";

/** Public storefront base (locale path) for building customer-facing links. */
const STOREFRONT = "https://www.thefashionproject.gr/en-eu";

/** Storefront root (default/Greek locale) — its search matches localized titles. */
const STOREFRONT_ROOT = "https://www.thefashionproject.gr";

/** Option name that carries the shoe size, across possible localisations. */
const SIZE_OPTION_RE = /size|μέγεθ|νούμερ/i;

export interface ShopifyProductSummary {
  title: string;
  handle: string;
  status: string;
  totalInventory: number;
  /**
   * custom.fit_advice metafield — the product's fit indication, e.g.
   * "True to size" / "Runs small" / "Runs large" (parsed to readable text).
   */
  fitAdvice?: string | null;
  /** custom.fit_and_sizing metafield — fuller fit/sizing guidance text. */
  fitAndSizing?: string | null;
  /** custom.color_sku — the model+colour SKU (shared across sizes), e.g. "21344096". */
  colorSku?: string | null;
  /** Per-size availability, from the product's variants. */
  sizes: { size: string; available: boolean }[];
  /**
   * 5-digit master/model code, from a variant SKU (master + 3-digit colour +
   * 3-digit size). Same master + different colour = another colour of this model.
   */
  master: string | null;
  /** True when custom.disable_notify_me_feature is "false" → the "Notify me" widget is on. */
  notifyMeEnabled: boolean;
  /** Standard Shopify product category name, e.g. "Sandals". */
  categoryName: string | null;
  /** Handle of the collection matching the category (for size-filter links). */
  categoryCollectionHandle: string | null;
}

const PRODUCT_FIELDS = `
  title handle status totalInventory
  fitAdvice: metafield(namespace: "custom", key: "fit_advice") { value }
  fitAndSizing: metafield(namespace: "custom", key: "fit_and_sizing") { value }
  colorSku: metafield(namespace: "custom", key: "color_sku") { value }
  notify: metafield(namespace: "custom", key: "disable_notify_me_feature") { value }
  category { name }
  collections(first: 40) { edges { node { handle title } } }
  variants(first: 40) { edges { node { sku availableForSale selectedOptions { name value } } } }
`;

interface Variant {
  sku: string | null;
  availableForSale: boolean;
  selectedOptions: { name: string; value: string }[];
}
interface ProductNode {
  title: string;
  handle: string;
  status: string;
  totalInventory: number;
  fitAdvice?: { value: string } | null;
  fitAndSizing?: { value: string } | null;
  colorSku?: { value: string } | null;
  notify?: { value: string } | null;
  category?: { name: string } | null;
  collections: { edges: { node: { handle: string; title: string } }[] };
  variants: { edges: { node: Variant }[] };
}

// custom.fit_advice is a list.single_line_text_field → its value is a JSON array
// string like `["True to size"]`. Parse to a readable, comma-joined string.
function parseListText(value?: string | null): string | null {
  if (!value) return null;
  try {
    const arr = JSON.parse(value);
    if (Array.isArray(arr)) return arr.filter(Boolean).join(", ") || null;
  } catch {
    /* not JSON — fall through to the raw value */
  }
  return value.trim() || null;
}

/** The size value of a variant (the option whose name looks like a size). */
function sizeOf(v: { selectedOptions: { name: string; value: string }[] }): string | null {
  const opt = v.selectedOptions.find((o) => SIZE_OPTION_RE.test(o.name)) ?? v.selectedOptions[0];
  return opt?.value ?? null;
}

function toSummary(n: ProductNode): ShopifyProductSummary {
  const variants = n.variants.edges.map((e) => e.node);
  const sizes = variants
    .map((v) => ({ size: sizeOf(v), available: v.availableForSale }))
    .filter((s): s is { size: string; available: boolean } => !!s.size);
  const sku = variants.map((v) => v.sku).find((s) => s && /^\d{5}/.test(s)) ?? null;
  const categoryName = n.category?.name ?? null;
  const categoryCollectionHandle = categoryName
    ? n.collections.edges.find((e) => e.node.title.toLowerCase() === categoryName.toLowerCase())?.node.handle ?? null
    : null;
  return {
    title: n.title,
    handle: n.handle,
    status: n.status,
    totalInventory: n.totalInventory,
    fitAdvice: parseListText(n.fitAdvice?.value),
    fitAndSizing: n.fitAndSizing?.value?.trim() || null,
    colorSku: n.colorSku?.value?.trim() || null,
    sizes,
    master: sku ? sku.slice(0, 5) : null,
    notifyMeEnabled: (n.notify?.value ?? "true") === "false",
    categoryName,
    categoryCollectionHandle,
  };
}

const BY_HANDLE_QUERY = `query($q: String!) {
  products(first: 1, query: $q) { edges { node { ${PRODUCT_FIELDS} } } }
}`;

/** Looks up a single product by its handle (e.g. from a product link). */
export async function getProductByHandle(
  handle: string,
): Promise<ShopifyProductSummary | null> {
  const q = handleQuery(handle);
  if (!q) return null;
  const data = await shopifyGraphQL<{ products: { edges: { node: ProductNode }[] } }>(
    BY_HANDLE_QUERY,
    { q },
  );
  const node = data.products.edges[0]?.node;
  return node ? toSummary(node) : null;
}

// Extract TFP product handles from any product links in free text, e.g.
//   https://www.thefashionproject.gr/en-eu/products/toe-ring-sandals-beige-suede?variant=…
// Optional locale segment (e.g. /en-eu/, /el/) is skipped; the handle is captured
// up to the first non-handle char (?, /, #, whitespace).
const HANDLE_RE =
  /thefashionproject\.gr\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/([a-z0-9][a-z0-9-]*)/gi;

export function extractProductHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HANDLE_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * Resolves a product NAME the customer typed to product handles, via the public
 * storefront predictive-search endpoint. Customers usually quote the title in
 * the STOREFRONT language (e.g. «Σουέντ σανδάλια με velcro - Μαύρο»), which is a
 * TRANSLATION — the Admin API only matches the primary (English) title, so it
 * finds nothing there. The storefront search indexes the shop's localized
 * content and matches the name in either language. Best-effort: [] on failure.
 */
export async function searchProductHandlesByName(name: string, limit = 2): Promise<string[]> {
  const q = name.trim();
  if (!q) return [];
  const url =
    `${STOREFRONT_ROOT}/search/suggest.json?q=${encodeURIComponent(q)}` +
    `&resources%5Btype%5D=product&resources%5Blimit%5D=${limit}`;
  try {
    const res = await resilientFetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      resources?: { results?: { products?: { handle?: string }[] } };
    };
    return (data.resources?.results?.products ?? [])
      .map((p) => p.handle)
      .filter((h): h is string => Boolean(h))
      .slice(0, limit);
  } catch {
    return [];
  }
}

const VARIANTS_BY_SKU = `query($q: String!) {
  productVariants(first: 100, query: $q) {
    edges { node { availableForSale selectedOptions { name value } product { title handle status } } }
  }
}`;

/**
 * Other colours of the SAME model (same 5-digit SKU master) that have `size` in
 * stock. Used to suggest an alternative colour when the linked product is sold
 * out in the size the customer asked for.
 */
export async function colourSiblingsWithSize(
  master: string,
  size: string,
): Promise<{ title: string; handle: string }[]> {
  if (!/^\d{5}$/.test(master)) return [];
  const data = await shopifyGraphQL<{
    productVariants: { edges: { node: {
      availableForSale: boolean;
      selectedOptions: { name: string; value: string }[];
      product: { title: string; handle: string; status: string };
    } }[] };
  }>(VARIANTS_BY_SKU, { q: `sku:${master}*` });
  const out = new Map<string, string>(); // handle -> title (deduped per product)
  for (const { node } of data.productVariants.edges) {
    if (node.product.status !== "ACTIVE") continue;
    if (sizeOf(node) === size && node.availableForSale) out.set(node.product.handle, node.product.title);
  }
  return [...out].map(([handle, title]) => ({ handle, title }));
}

/** Storefront link to a category collection filtered to in-stock items in `size`. */
export function sizeFilterUrl(collectionHandle: string, size: string): string {
  return `${STOREFRONT}/collections/${collectionHandle}?filter.v.option.shoe+size=${encodeURIComponent(size)}&filter.v.availability=1`;
}

/**
 * Link to the FULL catalog (Shopify's built-in `all` collection) filtered to
 * in-stock items in `size`. The fallback when we can't pin down a category.
 */
export function catalogSizeFilterUrl(size: string): string {
  return sizeFilterUrl("all", size);
}

const CATEGORY_SEARCH = `query($q: String!) {
  products(first: 30, query: $q) {
    edges { node { status category { name } collections(first: 40) { edges { node { handle title } } } } }
  }
}`;

/**
 * Best-effort CATEGORY (not exact product) for something the customer named but
 * didn't link — e.g. "Σανδάλια Fisherman Flatform - Μόκα Σουέντ". Title-searches
 * the text (dropping any trailing " - colour"), and if the ACTIVE matches agree
 * on a single category collection, returns it, so we can link available items of
 * that category in the asked size. Returns null when nothing matches or the
 * category is ambiguous — the caller then falls back to the full catalog.
 */
export async function inferCategoryCollection(
  productText: string,
): Promise<{ categoryName: string; collectionHandle: string } | null> {
  // Colourway after a dash breaks the match (e.g. "… - Μόκα Σουέντ" → 0 results),
  // so try the name without the trailing colour first, then the raw text.
  const withoutColour = productText.replace(/\s*[-–—:]\s*\S.*$/s, "").trim();
  for (const q of [...new Set([withoutColour, productText.trim()])]) {
    if (q.length < 3) continue;
    const data = await shopifyGraphQL<{
      products: { edges: { node: {
        status: string;
        category: { name: string } | null;
        collections: { edges: { node: { handle: string; title: string } }[] };
      } }[] };
    }>(CATEGORY_SEARCH, { q }).catch(() => null);
    const nodes = (data?.products.edges ?? []).map((e) => e.node).filter((n) => n.status === "ACTIVE");
    if (!nodes.length) continue;
    const counts = new Map<string, { name: string; handle: string; n: number }>();
    for (const n of nodes) {
      const cat = n.category?.name;
      if (!cat) continue;
      const handle = n.collections.edges.find((e) => e.node.title.toLowerCase() === cat.toLowerCase())?.node.handle;
      if (!handle) continue;
      const cur = counts.get(handle) ?? { name: cat, handle, n: 0 };
      cur.n++;
      counts.set(handle, cur);
    }
    const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    // Require a strong majority so a mixed result set doesn't get mislabeled.
    if (top && top.n / nodes.length >= 0.6) return { categoryName: top.name, collectionHandle: top.handle };
  }
  return null;
}
