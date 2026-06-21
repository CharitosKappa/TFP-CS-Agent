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

export function isSupportedImageType(ct: string): ct is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(ct.toLowerCase());
}

/** True for any image/* attachment (broader than the model-supported subset). */
export function isImageAttachment(a: { contentType: string }): boolean {
  return a.contentType.toLowerCase().startsWith("image/");
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
