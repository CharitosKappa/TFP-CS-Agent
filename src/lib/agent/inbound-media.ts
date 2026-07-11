import { getMessageAttachments } from "../graph/messages";
import { downscaleImage } from "../media/downscale";
import {
  extractDataUriImages,
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

/** Turns a base64 image payload into a model-ready InlineImage, downscaling when needed. */
async function toInlineImage(base64: string): Promise<InlineImage | null> {
  // Trust the actual bytes, not any declared contentType: a mislabeled image
  // makes Claude 400 and kills the draft. Sniff the real type from magic bytes;
  // count only base64 data chars so the size estimate isn't inflated by whitespace.
  const sniffed = sniffImageType(base64);
  const b64Len = base64.replace(/[^A-Za-z0-9+/]/g, "").length;
  const rawBytes = Math.floor((b64Len * 3) / 4);
  if (sniffed && rawBytes <= MAX_IMAGE_BYTES) return { mediaType: sniffed, data: base64 };
  // Too large, or a type we couldn't positively identify → downscale/re-encode.
  return await downscaleImage(base64);
}

/**
 * Best-effort: assemble the customer message's images for the draft model (vision,
 * capped) PLUS a text summary of everything received — so the agent never re-asks
 * for files/photos the customer already sent. Images come from BOTH real file
 * attachments AND base64 images embedded in the HTML body (`bodyHtml`). Cloud/
 * reference attachments (OneDrive links) carry no bytes, so they're noted in the
 * summary for a human to open.
 */
export async function fetchInboundMedia(
  graphMessageId: string,
  bodyHtml?: string,
): Promise<InboundMedia> {
  try {
    const { files, references } = await getMessageAttachments(graphMessageId);
    const imageAtts = files.filter(isImageAttachment);
    const fileAtts = files.filter((a) => !isImageAttachment(a));
    const embedded = bodyHtml ? extractDataUriImages(bodyHtml) : [];

    const images: InlineImage[] = [];
    for (const a of imageAtts) {
      if (images.length >= MAX_IMAGES) break;
      if (!a.contentBytes) continue;
      const img = await toInlineImage(a.contentBytes);
      if (img) images.push(img);
    }
    // Then images embedded as data: URIs in the body (photos pasted inline).
    for (const b64 of embedded) {
      if (images.length >= MAX_IMAGES) break;
      const img = await toInlineImage(b64);
      if (img) images.push(img);
    }

    const totalImages = imageAtts.length + embedded.length;
    if (totalImages === 0 && fileAtts.length === 0 && references.length === 0) {
      return { images: [] };
    }

    const parts: string[] = [];
    if (totalImages) parts.push(`${totalImages} εικόνα(ες)`);
    if (fileAtts.length) parts.push(`${fileAtts.length} αρχείο(α)`);
    if (references.length) parts.push(`${references.length} συνδεδεμένο(α) αρχείο(α) cloud`);
    const names = [...files.map((a) => a.name), ...references.map((r) => r.name)].filter(Boolean).join(", ");
    const hidden = totalImages - images.length; // couldn't show (cap/type/downscale)

    let summary = `Ο πελάτης ΕΧΕΙ ΣΤΕΙΛΕΙ ${parts.join(" + ")}${names ? `: ${names}` : ""}. Μην πεις στον πελάτη ότι δεν έλαβες αρχεία.`;
    if (images.length) {
      summary += ` ${images.length} από τις εικόνες εμφανίζονται παρακάτω ώστε να τις δεις — μην τις ξαναζητήσεις.`;
    }
    if (hidden > 0) {
      summary += ` ${hidden} εικόνα(ες) εστάλησαν αλλά ΔΕΝ εμφανίζονται εδώ (π.χ. μη υποστηριζόμενος τύπος, πολύ μεγάλο αρχείο ή πάνω από το όριο)· αν χρειάζεσαι το περιεχόμενό τους, ζήτησε ευγενικά να τις ξαναστείλει σε JPG/PNG.`;
    }
    if (fileAtts.length) {
      summary += ` Τα μη-εικονικά αρχεία (${fileAtts.length}) δεν εμφανίζονται εδώ αλλά ελήφθησαν και θα τα ελέγξει ο συνεργάτης — μην τα ξαναζητήσεις.`;
    }
    if (references.length) {
      summary += ` ${references.length} αρχείο(α) εστάλησαν ως ΣΥΝΔΕΣΜΟΙ cloud (OneDrive/SharePoint) — δεν τα ανοίγουμε αυτόματα, θα τα ελέγξει συνεργάτης· μην τα ξαναζητήσεις και μην υποθέτεις το περιεχόμενό τους.`;
    }
    return { images, summary };
  } catch (e) {
    log.warn("attachment_fetch_failed", { ...errInfo(e) });
    return { images: [] };
  }
}
