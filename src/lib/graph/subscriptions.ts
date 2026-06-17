import { getEnv } from "../env";
import { graphFetch } from "./client";

// Graph max subscription length for Outlook message resources (~70.5h).
const MAX_MINUTES = 4230;

export interface GraphSubscription {
  id: string;
  resource: string;
  expirationDateTime: string;
  notificationUrl: string;
  clientState?: string;
}

function expiry(): string {
  return new Date(Date.now() + MAX_MINUTES * 60 * 1000).toISOString();
}

/**
 * Creates a "created" subscription on the shared mailbox inbox.
 * NOTE: Graph immediately POSTs a validation request to the notificationUrl,
 * so /api/graph/notifications must be live & publicly reachable first.
 */
export async function createInboxSubscription(): Promise<GraphSubscription> {
  const env = getEnv();
  if (!env.GRAPH_WEBHOOK_NOTIFICATION_URL || !env.GRAPH_WEBHOOK_CLIENT_STATE) {
    throw new Error(
      "Set GRAPH_WEBHOOK_NOTIFICATION_URL and GRAPH_WEBHOOK_CLIENT_STATE in .env first.",
    );
  }
  const res = await graphFetch("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      changeType: "created",
      notificationUrl: env.GRAPH_WEBHOOK_NOTIFICATION_URL,
      resource: `/users/${env.GRAPH_MAILBOX}/mailFolders/inbox/messages`,
      expirationDateTime: expiry(),
      clientState: env.GRAPH_WEBHOOK_CLIENT_STATE,
    }),
  });
  return (await res.json()) as GraphSubscription;
}

/** Extends a subscription before it expires (run on a schedule). */
export async function renewSubscription(id: string): Promise<GraphSubscription> {
  const res = await graphFetch(`/subscriptions/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ expirationDateTime: expiry() }),
  });
  return (await res.json()) as GraphSubscription;
}

export async function listSubscriptions(): Promise<GraphSubscription[]> {
  const res = await graphFetch("/subscriptions");
  const data = (await res.json()) as { value: GraphSubscription[] };
  return data.value;
}

export async function deleteSubscription(id: string): Promise<void> {
  await graphFetch(`/subscriptions/${id}`, { method: "DELETE" });
}
