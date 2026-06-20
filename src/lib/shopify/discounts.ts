import { getEnv } from "../env";
import { getShopifyToken, shopifyGraphQL } from "./client";

export interface ShopifyDiscountSummary {
  code: string;
  title: string;
  /** ACTIVE | EXPIRED | SCHEDULED | UNKNOWN */
  status: string;
  startsAt?: string | null;
  endsAt?: string | null;
  /** Human-readable conditions, e.g. "10% off, minimum €50". */
  summary?: string | null;
}

interface DiscountNode {
  __typename?: string;
  title?: string | null;
  status?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  summary?: string | null;
}

// Requires the `read_discounts` access scope on the app.
const DISCOUNT_QUERY = `query($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    codeDiscount {
      __typename
      ... on DiscountCodeBasic { title status startsAt endsAt summary }
      ... on DiscountCodeBxgy { title status startsAt endsAt summary }
      ... on DiscountCodeFreeShipping { title status startsAt endsAt summary }
    }
  }
}`;

/** Looks up a discount code's status + conditions. Returns null if it doesn't exist. */
export async function getDiscountByCode(
  code: string,
): Promise<ShopifyDiscountSummary | null> {
  const c = code.trim();
  if (!c) return null;

  const data = await shopifyGraphQL<{
    codeDiscountNodeByCode: { codeDiscount: DiscountNode | null } | null;
  }>(DISCOUNT_QUERY, { code: c });

  const d = data.codeDiscountNodeByCode?.codeDiscount;
  if (!d) return null;

  return {
    code: c,
    title: d.title ?? c,
    status: d.status ?? "UNKNOWN",
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
    summary: d.summary ?? null,
  };
}

// ── Legacy price-rule discounts ──────────────────────────────────────────
// Older discounts use the legacy PriceRule model, which the modern code-discount
// queries do NOT return. There's no GraphQL "find price rule by code" resolver
// (the priceRules list query was removed), so we fall back to the REST lookup
// endpoint. Requires the `read_price_rules` scope. REST Admin API is legacy but
// still functional; this path exists only so legacy codes don't read as "missing".

interface PriceRuleNode {
  title?: string | null;
  // Shopify-COMPUTED status (authoritative — not derived from dates here).
  status?: string | null; // ACTIVE | EXPIRED | SCHEDULED
  startsAt?: string | null;
  endsAt?: string | null;
  valueV2?:
    | { __typename: "PricingPercentageValue"; percentage: number }
    | { __typename: "MoneyV2"; amount: string; currencyCode: string }
    | null;
  itemEntitlements?: {
    targetAllLineItems?: boolean;
    collections?: { nodes: { id: string }[] };
    products?: { nodes: { id: string }[] };
  } | null;
  prerequisiteSubtotalRange?: { greaterThanOrEqualTo?: string | null } | null;
}

const PRICE_RULE_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PriceRule {
      title status startsAt endsAt
      valueV2 { __typename ... on PricingPercentageValue { percentage } ... on MoneyV2 { amount currencyCode } }
      itemEntitlements { targetAllLineItems collections(first: 1) { nodes { id } } products(first: 1) { nodes { id } } }
      prerequisiteSubtotalRange { greaterThanOrEqualTo }
    }
  }
}`;

function priceRuleSummary(pr: PriceRuleNode): string {
  const v = pr.valueV2;
  let value = "";
  if (v?.__typename === "PricingPercentageValue") {
    value = `${Math.abs(v.percentage)}% έκπτωση`;
  } else if (v?.__typename === "MoneyV2") {
    const amt = Math.abs(parseFloat(v.amount));
    value = `${amt}${v.currencyCode === "EUR" ? "€" : " " + v.currencyCode} έκπτωση`;
  }
  const ent = pr.itemEntitlements;
  const restricted =
    !!ent &&
    ent.targetAllLineItems === false &&
    ((ent.collections?.nodes.length ?? 0) > 0 || (ent.products?.nodes.length ?? 0) > 0);
  const scope = restricted
    ? "ισχύει μόνο για επιλεγμένα προϊόντα/συλλογές"
    : "ισχύει σε όλα τα προϊόντα";
  const min = pr.prerequisiteSubtotalRange?.greaterThanOrEqualTo
    ? `ελάχιστη αξία ${pr.prerequisiteSubtotalRange.greaterThanOrEqualTo}€`
    : "";
  return [value, scope, min].filter(Boolean).join(" · ");
}

/**
 * Looks up a LEGACY (price-rule) discount by code via REST. Used as a fallback
 * when getDiscountByCode (modern) returns null. Returns null if the code doesn't
 * exist; throws on missing scope / transport errors (caller treats as not-found).
 */
export async function getLegacyDiscountByCode(
  code: string,
): Promise<ShopifyDiscountSummary | null> {
  const c = code.trim();
  if (!c) return null;
  const env = getEnv();
  const token = await getShopifyToken();
  const base = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`;

  // 1. Resolve the code → 303 redirect whose Location carries the price_rule id.
  const lookup = await fetch(`${base}/discount_codes/lookup.json?code=${encodeURIComponent(c)}`, {
    headers: { "X-Shopify-Access-Token": token },
    redirect: "manual",
  });
  if (lookup.status === 404) return null;
  const location = lookup.headers.get("location");
  if (lookup.status < 300 || lookup.status >= 400 || !location) {
    throw new Error(`Shopify price-rule lookup failed (${lookup.status})`);
  }
  const priceRuleId = location.match(/price_rules\/(\d+)/)?.[1];
  if (!priceRuleId) return null;

  // 2. Read the rule's authoritative details (incl. Shopify-computed status) via GraphQL.
  const data = await shopifyGraphQL<{ node: PriceRuleNode | null }>(PRICE_RULE_QUERY, {
    id: `gid://shopify/PriceRule/${priceRuleId}`,
  });
  const pr = data.node;
  if (!pr) return null;

  return {
    code: c,
    title: pr.title ?? c,
    status: pr.status ?? "UNKNOWN",
    startsAt: pr.startsAt ?? null,
    endsAt: pr.endsAt ?? null,
    summary: priceRuleSummary(pr),
  };
}
