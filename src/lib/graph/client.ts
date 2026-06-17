import { ConfidentialClientApplication } from "@azure/msal-node";
import { getEnv } from "../env";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let cca: ConfidentialClientApplication | null = null;

function app(): ConfidentialClientApplication {
  if (!cca) {
    const env = getEnv();
    cca = new ConfidentialClientApplication({
      auth: {
        clientId: env.GRAPH_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}`,
        clientSecret: env.GRAPH_CLIENT_SECRET,
      },
    });
  }
  return cca;
}

/** Acquires an app-only (client credentials) token for Microsoft Graph. */
export async function getGraphToken(): Promise<string> {
  const result = await app().acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) {
    throw new Error("Failed to acquire Microsoft Graph access token");
  }
  return result.accessToken;
}

/** Thin authenticated fetch wrapper for the Graph REST API. */
export async function graphFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getGraphToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Graph ${res.status} ${path}: ${await res.text()}`);
  }
  return res;
}

/** Verifies app-only auth and access to the configured shared mailbox inbox. */
export async function graphHealthCheck(): Promise<Record<string, unknown>> {
  const env = getEnv();
  const res = await graphFetch(
    `/users/${encodeURIComponent(env.GRAPH_MAILBOX)}/mailFolders/inbox`,
  );
  const data = (await res.json()) as { totalItemCount?: number };
  return { mailbox: env.GRAPH_MAILBOX, inboxItems: data.totalItemCount ?? null };
}
