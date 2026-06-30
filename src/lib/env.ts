import { z } from "zod";

/**
 * Typed, validated environment configuration.
 * Parsing is lazy (via getEnv) so `next build` doesn't fail when secrets are
 * absent — only code paths that actually call an external service require them.
 */
// In a .env, an unset optional var is usually present-but-empty ("") rather than
// absent. Treat "" as undefined so .optional()/.url() don't reject blank lines.
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const EnvSchema = z.object({
  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
  ANTHROPIC_TRIAGE_MODEL: z.string().default("claude-haiku-4-5"),

  // Microsoft Graph
  GRAPH_TENANT_ID: z.string().min(1),
  GRAPH_CLIENT_ID: z.string().min(1),
  GRAPH_CLIENT_SECRET: z.string().min(1),
  GRAPH_MAILBOX: z.string().min(1),
  // Extra email domains that count as "us" — the mailbox's aliases on other
  // domains (e.g. the *.onmicrosoft.com tenant domain), comma-separated. The
  // GRAPH_MAILBOX's own domain is always treated as internal automatically, so
  // this is only for aliases on a DIFFERENT domain. Used to tell our own
  // addresses apart from the customer when threading (see ingestion/sync.ts).
  INTERNAL_EMAIL_DOMAINS: z.preprocess(emptyToUndefined, z.string().optional()),
  // Optional — only needed for the webhook subscription (manual sync works without these).
  GRAPH_WEBHOOK_NOTIFICATION_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  GRAPH_WEBHOOK_CLIENT_STATE: z.preprocess(emptyToUndefined, z.string().optional()),

  // Shopify — Dev Dashboard custom app. The Admin API token is fetched at runtime
  // via the OAuth client_credentials grant from these client id/secret (see
  // shopify/client.ts), not stored statically.
  SHOPIFY_STORE_DOMAIN: z.string().min(1),
  SHOPIFY_CLIENT_ID: z.string().min(1),
  SHOPIFY_CLIENT_SECRET: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().default("2025-10"),

  // Odoo — self-hosted, read-only RMA/order lookups over JSON-RPC. The agent
  // authenticates as a dedicated read-only user with an API key (not a
  // password); see odoo/client.ts. HTTPS only — the key is sent in the body.
  ODOO_URL: z.string().url(),
  ODOO_DB: z.string().min(1),
  ODOO_API_USER: z.string().min(1),
  ODOO_API_KEY: z.string().min(1),

  // Database
  DATABASE_URL: z.string().min(1),
});

// NOTE: Auth (Entra ID SSO), the machine-route secret and the data-retention
// window are read directly from process.env (see src/auth.ts, src/lib/auth/*,
// src/lib/privacy/retention.ts) and documented in .env.example — they are
// intentionally NOT funnelled through getEnv() so the dashboard/middleware don't
// require the full external-service config just to render.

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid/missing environment variables:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the values.`,
    );
  }
  cached = parsed.data;
  return cached;
}
