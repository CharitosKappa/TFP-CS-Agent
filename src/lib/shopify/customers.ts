import { shopifyGraphQL } from "./client";

export interface ShopifyCustomerSummary {
  name: string;
  email: string;
  numberOfOrders: string;
  amountSpent: string;
  currency: string;
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

/** Looks up a customer by email, with their most recent orders. */
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
    recentOrders: node.orders.edges.map((o) => ({
      name: o.node.name,
      createdAt: o.node.createdAt,
      fulfillmentStatus: o.node.displayFulfillmentStatus,
      financialStatus: o.node.displayFinancialStatus,
    })),
  };
}
