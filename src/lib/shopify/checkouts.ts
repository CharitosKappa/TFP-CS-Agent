import { errInfo, log } from "../observability/logger";
import { shopifyGraphQL } from "./client";

export interface AbandonedCheckoutSummary {
  name: string;
  createdAt: string;
  total: string;
  currency: string;
  items: { title: string; quantity: number }[];
  /** The Shopify "recover" URL — lets the customer complete the SAME checkout. */
  recoveryUrl: string;
}

// Server-side narrowing: `query` with the BARE email full-text-matches the
// checkout's email (the `email:` FIELD prefix is silently ignored — verified — and
// would return store-wide results). We still match customer.email exactly on the
// client (below) as the authoritative guard. Cheap scan fields, newest-first.
const SCAN_QUERY = `query($q: String!, $cursor: String) {
  abandonedCheckouts(first: 50, sortKey: CREATED_AT, reverse: true, query: $q, after: $cursor) {
    edges { cursor node { id createdAt completedAt customer { email } } }
    pageInfo { hasNextPage }
  }
}`;

const DETAIL_QUERY = `query($id: ID!) {
  node(id: $id) { ... on AbandonedCheckout {
    name createdAt abandonedCheckoutUrl
    totalPriceSet { shopMoney { amount currencyCode } }
    lineItems(first: 20) { edges { node { title quantity } } }
  } }
}`;

interface ScanNode {
  id: string;
  createdAt: string;
  completedAt: string | null;
  customer: { email: string | null } | null;
}

/**
 * The customer's most recent INCOMPLETE checkout (abandoned cart) by exact email.
 *
 * SECURITY: `abandonedCheckouts` does NOT support server-side email filtering — it
 * silently ignores `query:"email:…"` and returns store-wide checkouts. So we scan
 * newest-first and match `customer.email` CLIENT-SIDE, exactly. The recovery URL
 * authorizes completing (and paying for) that checkout, so we return ONLY a
 * checkout whose own email matches the given (verified) address — never anyone
 * else's. Bounded: stops once checkouts are older than `sinceDays` or after
 * `maxScan` records, so it can't run away on a busy store.
 */
export async function findAbandonedCheckoutByEmail(
  email: string,
  opts: { sinceDays?: number; maxScan?: number } = {},
): Promise<AbandonedCheckoutSummary | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const cutoffMs = Date.now() - (opts.sinceDays ?? 30) * 86_400_000;
  const maxScan = opts.maxScan ?? 300;

  try {
    let cursor: string | null = null;
    let scanned = 0;
    let matchId: string | null = null;
    scan: while (scanned < maxScan) {
      const data: {
        abandonedCheckouts: { edges: { cursor: string; node: ScanNode }[]; pageInfo: { hasNextPage: boolean } };
      } = await shopifyGraphQL(SCAN_QUERY, { q: target, cursor });
      const edges = data.abandonedCheckouts.edges;
      if (!edges.length) break;
      for (const { node } of edges) {
        scanned++;
        // Newest-first: once we pass the cutoff, everything after is older too.
        if (new Date(node.createdAt).getTime() < cutoffMs) break scan;
        if (node.completedAt) continue; // completed → not an abandoned cart
        if (node.customer?.email?.toLowerCase() === target) { matchId = node.id; break scan; }
      }
      if (!data.abandonedCheckouts.pageInfo.hasNextPage) break;
      cursor = edges[edges.length - 1].cursor;
    }
    if (!matchId) return null;

    const detail: {
      node: {
        name: string;
        createdAt: string;
        abandonedCheckoutUrl: string | null;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        lineItems: { edges: { node: { title: string; quantity: number } }[] };
      } | null;
    } = await shopifyGraphQL(DETAIL_QUERY, { id: matchId });
    const n = detail.node;
    if (!n?.abandonedCheckoutUrl) return null;
    return {
      name: n.name,
      createdAt: n.createdAt,
      total: n.totalPriceSet.shopMoney.amount,
      currency: n.totalPriceSet.shopMoney.currencyCode,
      items: n.lineItems.edges.map((e) => ({ title: e.node.title, quantity: e.node.quantity })),
      recoveryUrl: n.abandonedCheckoutUrl,
    };
  } catch (e) {
    log.error("shopify_abandoned_checkout_lookup_failed", errInfo(e));
    return null; // best-effort — never block drafting
  }
}
