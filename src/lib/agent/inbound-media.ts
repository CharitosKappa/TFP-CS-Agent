import { getMessageAttachments } from "../graph/messages";
import { downscaleImage } from "../media/downscale";
import {
  isImageAttachment,
  sniffImageType,
  type InlineImage,
} from "../media/image";
import { errInfo, log } from "../observability/logger";

// Image attachments fed to the draft model (vision). Bounded for cost/limits.
// Cap keeps base64 under Claude's ~5MB/image limit (3.5MB raw ≈ 4.6MB base64).
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3_500_000;

export interface InboundMedia {
  images: InlineImage[];
  /** Text the model always sees, so it knows what was attached (even oversized/non-image). */
  summary?: string;
}

/**
 * Best-effort: fetch the customer message's attachments. Returns the image bytes
 * the model can "see" (vision, capped) PLUS a text summary of ALL attachments —
 * so the agent never re-asks for files/photos the customer already sent.
 */
export async function fetchInboundMedia(graphMessageId: string): Promise<InboundMedia> {
  try {
    const attachments = await getMessageAttachments(graphMessageId);
    if (!attachments.length) return { images: [] };

    const imageAtts = attachments.filter(isImageAttachment);
    const fileAtts = attachments.filter((a) => !isImageAttachment(a));

    const images: InlineImage[] = [];
    for (const a of imageAtts) {
      if (images.length >= MAX_IMAGES) break;
      if (!a.contentBytes) continue;
      // Trust the actual bytes, not Graph's declared contentType: a mislabeled
      // image (e.g. a PNG content type on JPEG bytes) makes Claude reject the
      // whole request with a 400 that kills the draft. Sniff the real type from
      // the magic bytes; anything we can't positively identify as a supported
      // type falls through to the re-encode path below.
      const sniffed = sniffImageType(a.contentBytes);
      // Trust the bytes we actually hold, not Graph's reported `size` — it can
      // be missing (defaulted to 0), which would let an oversized image through
      // un-downscaled and trip Claude's per-image limit (a 400 that kills the draft).
      const rawBytes = Math.floor((a.contentBytes.length * 3) / 4);
      if (sniffed && rawBytes <= MAX_IMAGE_BYTES) {
        images.push({ mediaType: sniffed, data: a.contentBytes });
      } else {
        // Too large, or a type we couldn't positively identify → downscale/
        // re-encode to a safe JPEG.
        const ds = await downscaleImage(a.contentBytes);
        if (ds) images.push(ds);
      }
    }

    const parts: string[] = [];
    if (imageAtts.length) parts.push(`${imageAtts.length} εικόνα(ες)`);
    if (fileAtts.length) parts.push(`${fileAtts.length} αρχείο(α)`);
    const names = attachments.map((a) => a.name).join(", ");
    // Images the customer attached but we could NOT show the model (over the
    // count cap, missing bytes, unsupported type, or a failed downscale).
    const hidden = imageAtts.length - images.length;

    let summary = `Ο πελάτης ΕΧΕΙ ΕΠΙΣΥΝΑΨΕΙ ${parts.join(" + ")}: ${names}. Μην πεις στον πελάτη ότι δεν έλαβες αρχεία.`;
    if (images.length) {
      summary += ` ${images.length} από τις εικόνες εμφανίζονται παρακάτω ώστε να τις δεις — μην τις ξαναζητήσεις.`;
    }
    if (hidden > 0) {
      summary += ` ${hidden} εικόνα(ες) εστάλησαν αλλά ΔΕΝ εμφανίζονται εδώ (π.χ. μη υποστηριζόμενος τύπος, πολύ μεγάλο αρχείο ή πάνω από το όριο εικόνων)· αν χρειάζεσαι το περιεχόμενό τους για να απαντήσεις, ζήτησε ευγενικά από τον πελάτη να τις ξαναστείλει σε μορφή JPG/PNG.`;
    }
    if (fileAtts.length) {
      summary += ` Τα μη-εικονικά αρχεία (${fileAtts.length}) δεν εμφανίζονται εδώ αλλά έχουν ληφθεί και θα τα ελέγξει ο συνεργάτης — μην τα ξαναζητήσεις.`;
    }
    return { images, summary };
  } catch (e) {
    log.warn("attachment_fetch_failed", { ...errInfo(e) });
    return { images: [] };
  }
}
