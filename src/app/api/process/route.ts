import { NextResponse } from "next/server";
import { processNewInboundMessages } from "@/lib/agent/process";

export const dynamic = "force-dynamic";

/** Drafts replies for inbound messages without one. POST /api/process?limit=10 */
export async function POST(req: Request) {
  const parsed = Number(new URL(req.url).searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(parsed) ? parsed : 10;
  try {
    const result = await processNewInboundMessages(limit);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
