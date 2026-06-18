const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Best-effort HTML → plain text (no external deps). */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * Plain text → minimal, safe HTML for an outgoing email body. Escapes markup,
 * turns blank lines into paragraphs and single newlines into <br>.
 */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

// Markers that typically begin a quoted reply chain.
const QUOTE_MARKERS: RegExp[] = [
  /-----\s*Original Message\s*-----/i,
  /^_{5,}\s*$/m,
  /^On .+ wrote:\s*$/im,
  /^Στις .+ έγραψε:?\s*$/im,
  /^From:\s.+$/im,
  /^Από:\s.+$/im,
];

/**
 * Best-effort removal of the quoted reply history so the agent sees only the
 * new message. The full HTML is retained separately, so nothing is lost.
 */
export function stripQuotedReply(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  const trimmed = text.slice(0, cut).trim();
  return trimmed.length > 0 ? trimmed : text.trim();
}
