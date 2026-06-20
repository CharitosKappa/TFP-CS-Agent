import sharp from "sharp";
import { errInfo, log } from "../observability/logger";

// Claude vision works best with the long edge ≤ ~1568px; keep the base64 well
// under the ~5MB/image API limit.
const MAX_EDGE = 1568;
const TARGET_MAX_BYTES = 3_500_000;

/**
 * Re-encodes an image (base64) to a Claude-safe JPEG: ≤1568px long edge, quality
 * stepped down until under the size target, EXIF-rotated. Returns null if it
 * can't be decoded or shrunk enough. Use for oversized or non-JPEG/PNG/GIF/WEBP
 * attachments so they can still be fed to the model instead of being dropped.
 */
export async function downscaleImage(
  base64: string,
): Promise<{ mediaType: "image/jpeg"; data: string } | null> {
  try {
    const input = Buffer.from(base64, "base64");
    for (const quality of [80, 65, 50, 40]) {
      const out = await sharp(input)
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (out.length <= TARGET_MAX_BYTES) {
        return { mediaType: "image/jpeg", data: out.toString("base64") };
      }
    }
    return null;
  } catch (e) {
    log.warn("image_downscale_failed", { ...errInfo(e) });
    return null;
  }
}
