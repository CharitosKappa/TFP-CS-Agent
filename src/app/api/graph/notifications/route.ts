import { safeEqual } from "@/lib/auth/internal";
import { ingestMessageById } from "@/lib/ingestion/sync";
import { errInfo, log } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

interface GraphNotification {
  clientState?: string;
  resource?: string;
  resourceData?: { id?: string };
}

/** Graph validation handshake: echo the validationToken as text/plain. */
function validationResponse(req: Request): Response | null {
  const token = new URL(req.url).searchParams.get("validationToken");
  if (token === null) return null;
  return new Response(token, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export function GET(req: Request): Response {
  return validationResponse(req) ?? new Response(null, { status: 400 });
}

export async function POST(req: Request): Promise<Response> {
  const validation = validationResponse(req);
  if (validation) return validation;

  const expected = process.env.GRAPH_WEBHOOK_CLIENT_STATE ?? "";
  // Fail closed: without a configured secret we cannot authenticate notifications,
  // so ingest nothing. Ack anyway to avoid Graph retry storms.
  if (!expected) {
    log.error("webhook_client_state_unset");
    return new Response(null, { status: 202 });
  }

  let body: { value?: GraphNotification[] };
  try {
    body = (await req.json()) as { value?: GraphNotification[] };
  } catch {
    return new Response(null, { status: 400 });
  }

  let rejected = 0;
  await Promise.all(
    (body.value ?? []).map(async (n) => {
      // Constant-time check; reject spoofed/empty clientState.
      if (!n.clientState || !safeEqual(n.clientState, expected)) {
        rejected++;
        return;
      }
      const id = n.resourceData?.id;
      if (!id) return;
      try {
        await ingestMessageById(id);
      } catch (e) {
        log.error("webhook_ingest_failed", errInfo(e));
      }
    }),
  );
  if (rejected > 0) log.warn("webhook_rejected_notifications", { rejected });

  // Acknowledge fast; Graph retries on non-2xx.
  return new Response(null, { status: 202 });
}
