import "dotenv/config";
import { anthropicHealthCheck } from "../src/lib/anthropic/client";
import { graphHealthCheck } from "../src/lib/graph/client";
import { shopifyHealthCheck } from "../src/lib/shopify/client";
import { odooHealthCheck } from "../src/lib/odoo/client";

async function run(
  name: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<boolean> {
  try {
    const data = await fn();
    console.log(`✓ ${name}:`, data);
    return true;
  } catch (e) {
    console.error(`✗ ${name}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

async function main() {
  const results = await Promise.all([
    run("Anthropic", anthropicHealthCheck),
    run("Microsoft Graph", graphHealthCheck),
    run("Shopify", shopifyHealthCheck),
    run("Odoo", odooHealthCheck),
  ]);
  if (results.some((ok) => !ok)) process.exit(1);
}

main();
