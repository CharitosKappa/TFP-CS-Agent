import { shopifyGraphQL } from "./client";
import { handleQuery } from "./search";

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
}

// The fit metafields we surface for size/fit questions.
const PRODUCT_FIELDS = `
  title handle status totalInventory
  fitAdvice: metafield(namespace: "custom", key: "fit_advice") { value }
  fitAndSizing: metafield(namespace: "custom", key: "fit_and_sizing") { value }
`;

interface ProductNode {
  title: string;
  handle: string;
  status: string;
  totalInventory: number;
  fitAdvice?: { value: string } | null;
  fitAndSizing?: { value: string } | null;
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

function toSummary(n: ProductNode): ShopifyProductSummary {
  return {
    title: n.title,
    handle: n.handle,
    status: n.status,
    totalInventory: n.totalInventory,
    fitAdvice: parseListText(n.fitAdvice?.value),
    fitAndSizing: n.fitAndSizing?.value?.trim() || null,
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
