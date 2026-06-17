import { getEnv } from "../env";

interface GraphQLResponse<T> {
  data?: T;
  errors?: unknown;
}

/** Executes a query against the Shopify Admin GraphQL API. */
export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const env = getEnv();
  const url = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  if (!json.data) {
    throw new Error("Shopify GraphQL: empty response");
  }
  return json.data;
}

/** Verifies the Admin API token by reading shop info. */
export async function shopifyHealthCheck(): Promise<Record<string, unknown>> {
  const data = await shopifyGraphQL<{
    shop: { name: string; myshopifyDomain: string };
  }>(`{ shop { name myshopifyDomain } }`);
  return { shop: data.shop.name, domain: data.shop.myshopifyDomain };
}
