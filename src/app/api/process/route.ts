import { NextResponse } from "next/server";
import { assertInternalSecret } from "@/lib/auth/internal";
import { processNewInboundMessages } from "@/lib/agent/process";
import { errInfo, log } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

function clampLimit(value: string | null, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

/**
 * Drafts replies for inbound messages without one. Requires the internal secret.
 *   POST /api/process?limit=10
 */
export async function POST(req: Request) {
  try {
    assertInternalSecret(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const limit = clampLimit(new URL(req.url).searchParams.get("limit"), 10);
  try {
    const result = await processNewInboundMessages(limit);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    log.error("process_route_failed", errInfo(e));
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
