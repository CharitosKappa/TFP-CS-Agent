import { NextResponse } from "next/server";
import { assertInternalSecret } from "@/lib/auth/internal";
import { processNewInboundMessages } from "@/lib/agent/process";
import { syncInbox } from "@/lib/ingestion/sync";
import { errInfo, log } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

/** Clamp a query limit into a safe range so it can't fan out unbounded work. */
function clampLimit(value: string | null, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

/**
 * Manually triggers an inbox sync. Requires the internal secret
 * (Authorization: Bearer <INTERNAL_API_SECRET> or x-internal-secret).
 *   POST /api/ingest?limit=25            — sync only
 *   POST /api/ingest?limit=25&draft=true — sync, then draft replies for new inbound
 */
export async function POST(req: Request) {
  try {
    assertInternalSecret(req);
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;
  const limit = clampLimit(params.get("limit"), 25);
  try {
    const result = await syncInbox({ limit });
    const drafting =
      params.get("draft") === "true"
        ? await processNewInboundMessages(limit)
        : undefined;
    return NextResponse.json({ ok: true, ...result, drafting });
  } catch (e) {
    log.error("ingest_route_failed", errInfo(e));
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
