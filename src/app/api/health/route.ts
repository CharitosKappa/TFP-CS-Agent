import { NextResponse } from "next/server";
import { anthropicHealthCheck } from "@/lib/anthropic/client";
import { assertInternalSecret } from "@/lib/auth/internal";
import { graphHealthCheck } from "@/lib/graph/client";
import { getQueueCount } from "@/lib/review/queue";
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

export async function GET(req: Request) {
  // Public callers get a minimal liveness probe only. Detailed status (which
  // discloses mailbox / shop / model ids and upstream errors) requires the
  // internal secret.
  try {
    assertInternalSecret(req);
  } catch {
    return NextResponse.json({ ok: true, status: "alive" });
  }

  const [anthropic, graph, shopify] = await Promise.all([
    check(anthropicHealthCheck),
    check(graphHealthCheck),
    check(shopifyHealthCheck),
  ]);

  let queueDepth: number | null = null;
  try {
    queueDepth = await getQueueCount();
  } catch {
    queueDepth = null;
  }

  const ok = anthropic.ok === true && graph.ok === true && shopify.ok === true;
  return NextResponse.json(
    { ok, services: { anthropic, graph, shopify }, metrics: { queueDepth } },
    { status: ok ? 200 : 503 },
  );
}
