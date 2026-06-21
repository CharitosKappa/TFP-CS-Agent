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
