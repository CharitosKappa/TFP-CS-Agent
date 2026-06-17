import { NextResponse } from "next/server";
import { anthropicHealthCheck } from "@/lib/anthropic/client";
import { graphHealthCheck } from "@/lib/graph/client";
import { shopifyHealthCheck } from "@/lib/shopify/client";

export const dynamic = "force-dynamic";

async function check(
  fn: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const [anthropic, graph, shopify] = await Promise.all([
    check(anthropicHealthCheck),
    check(graphHealthCheck),
    check(shopifyHealthCheck),
  ]);

  const ok = anthropic.ok === true && graph.ok === true && shopify.ok === true;
  return NextResponse.json(
    { ok, services: { anthropic, graph, shopify } },
    { status: ok ? 200 : 503 },
  );
}
