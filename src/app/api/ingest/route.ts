import { NextResponse } from "next/server";
import { processNewInboundMessages } from "@/lib/agent/process";
import { syncInbox } from "@/lib/ingestion/sync";

export const dynamic = "force-dynamic";

/**
 * Manually triggers an inbox sync.
 *   POST /api/ingest?limit=25            — sync only
 *   POST /api/ingest?limit=25&draft=true — sync, then draft replies for new inbound
 */
export async function POST(req: Request) {
  const params = new URL(req.url).searchParams;
  const parsed = Number(params.get("limit") ?? "25");
  const limit = Number.isFinite(parsed) ? parsed : 25;
  try {
    const result = await syncInbox({ limit });
    const drafting =
      params.get("draft") === "true" ? await processNewInboundMessages() : undefined;
    return NextResponse.json({ ok: true, ...result, drafting });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
