import { getEnv } from "../env";
import { resilientFetch } from "../http/resilient";
import { log } from "../observability/logger";

interface GraphQLResponse<T> {
  data?: T;
  errors?: unknown;
}

/**
 * Executes a query against the Shopify Admin GraphQL API with timeouts and
 * retries (429/5xx, honoring Retry-After). Logs upstream errors server-side but
 * throws concise messages so raw responses never reach the UI.
 */
export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const env = getEnv();
  const url = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  const res = await resilientFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    // Don't log the raw body — it can echo PII from variables. Status only.
    await res.text().catch(() => "");
    log.error("shopify_request_failed", { status: res.status });
    throw new Error(`Shopify request failed (${res.status})`);
  }
  const json = (await res.json()) as GraphQLResponse<T> & {
    extensions?: { cost?: { throttleStatus?: unknown } };
  };
  if (json.errors) {
    // Cost-based throttling surfaces as a GraphQL error with a THROTTLED code.
    const throttled = JSON.stringify(json.errors).includes("THROTTLED");
    log.error("shopify_graphql_errors", { throttled });
    throw new Error(
      throttled ? "Shopify rate limit (throttled)" : "Shopify GraphQL error",
    );
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
