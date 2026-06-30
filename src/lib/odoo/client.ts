import { getEnv } from "../env";
import { resilientFetch } from "../http/resilient";
import { log } from "../observability/logger";

// Self-hosted Odoo, accessed over its native JSON-RPC endpoint (/jsonrpc).
// We authenticate once as a dedicated read-only user (API key in place of a
// password) and cache the resulting uid; every subsequent call goes through
// `object`/`execute_kw`. No module install is needed on the Odoo side.

interface JsonRpcResponse<T> {
  result?: T;
  error?: { message?: string; data?: { name?: string; message?: string } };
}

// The numeric uid Odoo assigns the API user. Cached for the process lifetime —
// it only changes if the user is recreated, in which case a restart re-auths.
let cachedUid: number | null = null;

function invalidateUid(): void {
  cachedUid = null;
}

/**
 * Low-level JSON-RPC call. `service` is typically "common" (auth/version) or
 * "object" (model access). Throws a concise error on transport or RPC failure;
 * the raw Odoo error (which can echo argument values) is logged server-side
 * only, never surfaced.
 */
async function rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
  const env = getEnv();
  const res = await resilientFetch(`${env.ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // id is required by JSON-RPC but Odoo ignores its value; a constant is fine.
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: { service, method, args } }),
  });
  if (!res.ok) {
    await res.text().catch(() => ""); // drain; body may contain detail — don't log it
    log.error("odoo_request_failed", { status: res.status, service, method });
    throw new Error(`Odoo request failed (${res.status})`);
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) {
    const name = json.error.data?.name ?? "OdooError";
    // An expired/invalid session reads as an access error — drop the cached uid
    // so the next call re-authenticates.
    if (name.includes("AccessDenied") || name.includes("SessionExpired")) invalidateUid();
    log.error("odoo_rpc_error", { service, method, name });
    throw new Error(`Odoo RPC error (${name})`);
  }
  return json.result as T;
}

/**
 * Authenticates the API user and returns its uid, cached after the first call.
 * Odoo returns `false` (not an error) for bad credentials, which we surface as
 * a clear auth failure.
 */
export async function getOdooUid(): Promise<number> {
  if (cachedUid !== null) return cachedUid;
  const env = getEnv();
  const uid = await rpc<number | false>("common", "authenticate", [
    env.ODOO_DB,
    env.ODOO_API_USER,
    env.ODOO_API_KEY,
    {},
  ]);
  if (!uid) {
    log.error("odoo_auth_failed", { db: env.ODOO_DB });
    throw new Error("Odoo authentication failed — check ODOO_DB / ODOO_API_USER / ODOO_API_KEY");
  }
  cachedUid = uid;
  return uid;
}

/**
 * Calls a model method via execute_kw, e.g.
 *   execKw("sale.order", "search_read", [[["name", "=", "S00123"]]], { fields: ["name", "state"] })
 * Reads only, by convention — the bound Odoo user is read-only, so any write
 * method returns an AccessError from the server regardless of what we call.
 */
export async function execKw<T = unknown>(
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const env = getEnv();
  const uid = await getOdooUid();
  return rpc<T>("object", "execute_kw", [
    env.ODOO_DB,
    uid,
    env.ODOO_API_KEY,
    model,
    method,
    args,
    kwargs,
  ]);
}

/** Verifies connectivity + credentials by authenticating and reading the server version. */
export async function odooHealthCheck(): Promise<Record<string, unknown>> {
  const env = getEnv();
  const version = await rpc<{ server_version?: string }>("common", "version", []);
  const uid = await getOdooUid();
  return { db: env.ODOO_DB, uid, serverVersion: version.server_version ?? "unknown" };
}
