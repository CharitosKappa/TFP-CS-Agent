import { getEnv } from "@/lib/env";
import { ingestMessageById } from "@/lib/ingestion/sync";

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

  const expected = getEnv().GRAPH_WEBHOOK_CLIENT_STATE;

  let body: { value?: GraphNotification[] };
  try {
    body = (await req.json()) as { value?: GraphNotification[] };
  } catch {
    return new Response(null, { status: 400 });
  }

  await Promise.all(
    (body.value ?? []).map(async (n) => {
      // Reject spoofed notifications.
      if (expected && n.clientState !== expected) return;
      const id = n.resourceData?.id;
      if (!id) return;
      try {
        await ingestMessageById(id);
      } catch (e) {
        console.error("notification ingest failed:", e);
      }
    }),
  );

  // Acknowledge fast; Graph retries on non-2xx.
  return new Response(null, { status: 202 });
}
