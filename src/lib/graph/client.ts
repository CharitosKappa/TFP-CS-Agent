import { ConfidentialClientApplication } from "@azure/msal-node";
import { getEnv } from "../env";
import { resilientFetch, type ResilientOptions } from "../http/resilient";
import { log } from "../observability/logger";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

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

/** Strips the mailbox/user segment so paths can be logged without PII. */
function redactPath(path: string): string {
  return path.replace(/\/users\/[^/?]+/i, "/users/***");
}

/** Extracts a non-PII error code from a Graph error body, if present. */
function safeErrorCode(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: { code?: string }; code?: string };
    return j?.error?.code ?? j?.code;
  } catch {
    return undefined;
  }
}

/**
 * Authenticated, resilient fetch wrapper for the Graph REST API. Retries 429/5xx
 * with backoff (honoring Retry-After) and times out hung requests. On failure it
 * logs status + a redacted path + the upstream error CODE (never the raw body, which
 * can contain PII) and throws a concise error so raw responses never reach the UI.
 *
 * IMPORTANT: pass `{ retries: 0 }` for non-idempotent mutations (e.g. sending an
 * email) so a lost-response timeout/5xx can never silently re-send.
 */
export async function graphFetch(
  path: string,
  init: RequestInit = {},
  opts: ResilientOptions = {},
): Promise<Response> {
  const token = await getGraphToken();
  const res = await resilientFetch(
    `${GRAPH_BASE}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    opts,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.error("graph_request_failed", {
      status: res.status,
      path: redactPath(path),
      code: safeErrorCode(body),
    });
    throw new Error(`Microsoft Graph request failed (${res.status})`);
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
