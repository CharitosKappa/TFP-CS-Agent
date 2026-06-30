import { shopifyGraphQL } from "./client";

export interface ShopifyCustomerSummary {
  name: string;
  email: string;
  numberOfOrders: string;
  amountSpent: string;
  currency: string;
  /** Store credit balances on this customer's account (usually 0 or 1 entry). */
  storeCredit: { amount: string; currency: string }[];
  recentOrders: {
    name: string;
    createdAt: string;
    fulfillmentStatus: string;
    financialStatus: string;
  }[];
}

interface CustomerNode {
  firstName?: string | null;
  lastName?: string | null;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
  numberOfOrders: string;
  amountSpent: { amount: string; currencyCode: string };
  orders: {
    edges: {
      node: {
        name: string;
        createdAt: string;
        displayFulfillmentStatus: string;
        displayFinancialStatus: string;
      };
    }[];
  };
}

const CUSTOMER_QUERY = `query($q: String!) {
  customers(first: 1, query: $q) {
    edges { node {
      firstName lastName defaultEmailAddress { emailAddress } numberOfOrders
      amountSpent { amount currencyCode }
      orders(first: 5, sortKey: CREATED_AT, reverse: true) {
        edges { node { name createdAt displayFulfillmentStatus displayFinancialStatus } }
      }
    } }
  }
}`;

// Store credit lives behind its own access scope (read_store_credit_accounts),
// so it's queried separately and isolated: a missing scope or error degrades to
// "no store credit shown" rather than wiping the whole customer lookup.
const STORE_CREDIT_QUERY = `query($q: String!) {
  customers(first: 1, query: $q) {
    edges { node { storeCreditAccounts(first: 5) { edges { node { balance { amount currencyCode } } } } } }
  }
}`;

/** Store credit balances for a customer; [] on no account, missing scope, or error. */
async function getStoreCreditByEmail(
  email: string,
): Promise<{ amount: string; currency: string }[]> {
  try {
    const data = await shopifyGraphQL<{
      customers: {
        edges: { node: { storeCreditAccounts: { edges: { node: { balance: { amount: string; currencyCode: string } } }[] } } }[];
      };
    }>(STORE_CREDIT_QUERY, { q: `email:${email}` });
    const accounts = data.customers.edges[0]?.node.storeCreditAccounts.edges ?? [];
    return accounts.map((a) => ({
      amount: a.node.balance.amount,
      currency: a.node.balance.currencyCode,
    }));
  } catch (e) {
    console.error("store credit lookup failed:", e);
    return [];
  }
}

/** Looks up a customer by email, with their most recent orders and store credit. */
export async function getCustomerByEmail(
  email: string,
): Promise<ShopifyCustomerSummary | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;

  const data = await shopifyGraphQL<{ customers: { edges: { node: CustomerNode }[] } }>(
    CUSTOMER_QUERY,
    { q: `email:${e}` },
  );
  const node = data.customers.edges[0]?.node;
  if (!node) return null;

  return {
    name:
      [node.firstName, node.lastName].filter(Boolean).join(" ") ||
      (node.defaultEmailAddress?.emailAddress ?? e),
    email: node.defaultEmailAddress?.emailAddress ?? e,
    numberOfOrders: node.numberOfOrders,
    amountSpent: node.amountSpent.amount,
    currency: node.amountSpent.currencyCode,
    storeCredit: await getStoreCreditByEmail(e),
    recentOrders: node.orders.edges.map((o) => ({
      name: o.node.name,
      createdAt: o.node.createdAt,
      fulfillmentStatus: o.node.displayFulfillmentStatus,
      financialStatus: o.node.displayFinancialStatus,
    })),
  };
}
