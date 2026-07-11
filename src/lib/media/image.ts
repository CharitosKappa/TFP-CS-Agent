// Shared image types/helpers (no native deps — safe to import anywhere).

export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** An image ready to send to the model (base64 data + media type). */
export interface InlineImage {
  mediaType: SupportedImageType;
  data: string;
}

/**
 * Sniff the real image type from the leading "magic" bytes of a base64 payload.
 * Graph's declared contentType is sometimes wrong (e.g. a PNG label on JPEG
 * bytes), and Claude rejects an image whose declared media type doesn't match
 * its actual bytes (a 400 that kills the draft) — so we trust the bytes, not the
 * label. Returns null when the bytes don't match a model-supported image type.
 */
export function sniffImageType(base64: string): SupportedImageType | null {
  // 24 base64 chars ≈ 18 decoded bytes — plenty for every signature below.
  const head = Buffer.from(base64.slice(0, 24), "base64");
  if (head.length < 12) return null;
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  )
    return "image/png";
  // GIF: "GIF8"
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38)
    return "image/gif";
  // WEBP: "RIFF"????"WEBP"
  if (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** True for any image/* attachment (broader than the model-supported subset). */
export function isImageAttachment(a: { contentType: string }): boolean {
  return a.contentType.toLowerCase().startsWith("image/");
}

// Base64 data-URI images embedded directly in an HTML body (`<img
// src="data:image/…;base64,…">`) — some clients inline photos this way, so they
// are NOT Graph attachments. The payload runs until the closing quote/bracket.
const DATA_URI_IMAGE_RE = /data:image\/[\w.+-]+;base64,([^"')\s>]+)/gi;

/**
 * Extracts base64 payloads of images embedded as data: URIs in an HTML body.
 * Skips tiny ones (spacer/pixel gifs). Returns the raw base64 strings; the caller
 * sniffs/downscales them exactly like attachment bytes.
 */
export function extractDataUriImages(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(DATA_URI_IMAGE_RE)) {
    const b64 = m[1].replace(/\s/g, "");
    if (b64.length > 100) out.push(b64); // ~>75 bytes — skip spacer/tracking pixels
  }
  return out;
}

/**
 * An email "inline" (cid:) attachment this small is almost always a signature
 * logo or tracking pixel, not customer content — those we want to ignore. But
 * many mail clients embed a GENUINE customer photo inline too (isInline=true,
 * often 1–5 MB), so we only treat *small* inline attachments as cruft and keep
 * the large ones.
 */
export const INLINE_CRUFT_MAX_BYTES = 50_000;

export function isInlineCruft(a: { isInline: boolean; size: number }): boolean {
  return a.isInline && a.size <= INLINE_CRUFT_MAX_BYTES;
}
