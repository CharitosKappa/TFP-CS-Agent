import { shopifyGraphQL } from "./client";

export interface ShopifyProductSummary {
  title: string;
  handle: string;
  status: string;
  totalInventory: number;
}

const PRODUCT_QUERY = `query($q: String!) {
  products(first: 3, query: $q) {
    edges { node { title handle status totalInventory } }
  }
}`;

/** Free-text product search (title/sku/etc.) — for product questions. */
export async function searchProducts(term: string): Promise<ShopifyProductSummary[]> {
  const t = term.trim();
  if (!t) return [];
  const data = await shopifyGraphQL<{
    products: { edges: { node: ShopifyProductSummary }[] };
  }>(PRODUCT_QUERY, { q: t });
  return data.products.edges.map((e) => e.node);
}
