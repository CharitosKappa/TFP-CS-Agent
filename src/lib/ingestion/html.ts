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

/**
 * Best-effort HTML → plain text (no external deps): preserves hyperlink targets
 * as "text (url)", turns <br> and block/row closes into newlines, table cells
 * into tabs, list items into bullets, and decodes entities.
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  // Keep the link target: <a href="URL">text</a> → "text (URL)". Otherwise the
  // generic tag-strip below drops the href and any URL that lives only in it.
  // Only real web links (http/https); skip mailto:/tel:/anchors, and don't
  // duplicate when the visible text already shows the URL. (Entities in the URL,
  // e.g. &amp;, are decoded by the global pass further down.)
  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, dq, sq, uq, inner) => {
      const url = (dq ?? sq ?? uq ?? "").trim();
      const text = inner.replace(/<[^>]+>/g, "").trim();
      if (!/^https?:\/\//i.test(url)) return text;
      if (!text) return url;
      return text.includes(url) ? text : `${text} (${url})`;
    },
  );
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Separate table cells so a row's columns don't run together (trailing tabs are
  // cleaned with the other whitespace below).
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\t{2,}/g, "\t")
    .replace(/\n{3,}/g, "\n\n");
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
  // "wrote:" / "έγραψε:" headers — no end-of-line anchor, because some clients
  // put the quoted text right after the colon on the same line (e.g. Gmail:
  // "On … wrote: Hello…"), which a "$" would miss.
  /^On .+ wrote:/im,
  /^Στις .+ έγραψε:?/im,
  /^From:\s.+$/im,
  /^Από:\s.+$/im,
];

/**
 * Best-effort removal of the quoted reply history so the agent sees only the
 * new message. Note: the stripped history is discarded — only this trimmed
 * bodyText is persisted (the raw HTML is not stored; see PRIVACY.md).
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
