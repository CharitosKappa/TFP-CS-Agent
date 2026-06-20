import { getEnv } from "../env";
import { resilientFetch } from "../http/resilient";
import { log } from "../observability/logger";

interface GraphQLResponse<T> {
  data?: T;
  errors?: unknown;
}

// Cached Admin API token from the client_credentials grant (valid ~24h).
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function invalidateToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Returns an Admin API access token for the store, fetched via the OAuth 2.0
 * client_credentials grant (Dev Dashboard app on your own store). Cached and
 * reused until ~60s before its 24h expiry. Requires the app + store to be in the
 * same Dev Dashboard organisation, else Shopify returns shop_not_permitted.
 */
export async function getShopifyToken(): Promise<string> {
  const env = getEnv();
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const res = await resilientFetch(
    `https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
      }).toString(),
    },
    // A token fetch is cheap to redo; don't let retries mask auth/config errors.
    { retries: 0 },
  );
  if (!res.ok) {
    await res.text().catch(() => ""); // drain; body may contain error detail — don't log it
    log.error("shopify_token_failed", { status: res.status });
    throw new Error(`Shopify token request failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedToken;
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
  const token = await getShopifyToken();
  const url = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  const res = await resilientFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    // A revoked/expired token reads as 401 — drop the cache so the next call refetches.
    if (res.status === 401) invalidateToken();
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
