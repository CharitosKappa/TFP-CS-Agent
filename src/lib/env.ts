import { z } from "zod";

/**
 * Typed, validated environment configuration.
 * Parsing is lazy (via getEnv) so `next build` doesn't fail when secrets are
 * absent — only code paths that actually call an external service require them.
 */
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
  // Optional — only needed for the webhook subscription (manual sync works without these).
  GRAPH_WEBHOOK_NOTIFICATION_URL: z.string().url().optional(),
  GRAPH_WEBHOOK_CLIENT_STATE: z.string().optional(),

  // Shopify
  SHOPIFY_STORE_DOMAIN: z.string().min(1),
  SHOPIFY_ADMIN_TOKEN: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().default("2025-10"),

  // Database
  DATABASE_URL: z.string().min(1),
});

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
