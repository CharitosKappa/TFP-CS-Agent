import { timingSafeEqual } from "node:crypto";

/** Constant-time string compare (length-safe). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Guards machine-to-machine routes (ingest/process). Fails CLOSED: if
 * INTERNAL_API_SECRET is unset, every request is rejected. Accepts the secret
 * via `Authorization: Bearer <secret>` or the `x-internal-secret` header.
 * Throws on failure — callers map that to a 401.
 */
export function assertInternalSecret(req: Request): void {
  const expected = process.env.INTERNAL_API_SECRET ?? "";
  if (!expected) {
    throw new Error("INTERNAL_API_SECRET is not configured");
  }
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = /^bearer\s+/i.test(authHeader)
    ? authHeader.replace(/^bearer\s+/i, "").trim()
    : "";
  const provided = bearer || req.headers.get("x-internal-secret") || "";
  if (!provided || !safeEqual(provided, expected)) {
    throw new Error("Unauthorized");
  }
}
