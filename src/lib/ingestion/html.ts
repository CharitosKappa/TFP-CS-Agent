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

// Inbound email HTML is attacker-controlled and parsed with backtracking-prone
// regexes; cap the input so a multi-MB body engineered to maximise backtracking
// can't stall the (serial) drafting worker. Anything past this is almost always
// quoted cruft, which stripQuotedReply would drop anyway.
const MAX_HTML_CHARS = 512_000;

/**
 * Best-effort HTML → plain text (no external deps): preserves hyperlink targets
 * as "text (url)", turns <br> and block/row closes into newlines, table cells
 * into tabs, list items into bullets, and decodes entities.
 */
export function htmlToText(html: string): string {
  let s = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
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
  // Paragraph break (blank line) ONLY where the source signals one: a block that
  // carries a non-zero top/bottom margin (Outlook/webmail space real paragraphs
  // via CSS margins), or a semantic <p>/<h*>. A plain <div> is a soft line break —
  // Outlook wraps each line (incl. signatures) in its own <div>, and we want those
  // tight, like Shift+Enter. Empty blocks (<div><br></div>) still produce a blank
  // line via the <br> above; the \n{3,}→\n\n cleanup caps the runs.
  s = s.replace(/<(?:div|p)\b[^>]*\bmargin-(?:top|bottom)\s*:\s*[1-9][^>]*>/gi, "\n\n");
  s = s.replace(/<\/(p|h[1-6])>/gi, "\n\n");
  s = s.replace(/<\/(div|li|tr|ul|ol|blockquote|table)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\t{2,}/g, "\t")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Inline formatting for a single line: escape, then **bold** → <strong>, then
// bare URLs → clickable links. Order matters (escape first).
function inlineFmt(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}

/**
 * Rich text → HTML for an outgoing customer reply. Renders the light markdown the
 * drafting model produces — **bold**, "- "/"• " bullet lists, blank-line
 * paragraphs — and wraps it in the house font so replies look consistent with the
 * rest of the mailbox's mail (Outlook default: Aptos/Calibri 11pt).
 *
 * `disclaimer` (optional) is appended as a muted footer, visually separated — the
 * AI-transparency + human-opt-out note (see agent/disclaimer.ts).
 */
export function formatReplyHtml(text: string, disclaimer?: string): string {
  const blocks = text.trim().split(/\n{2,}/);
  const body = blocks
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim().length > 0);
      const isList = lines.length > 0 && lines.every((l) => /^\s*[-•]\s+/.test(l));
      if (isList) {
        const items = lines
          .map((l) => `<li>${inlineFmt(l.replace(/^\s*[-•]\s+/, ""))}</li>`)
          .join("");
        return `<ul style="margin:0 0 10px 0; padding-left:22px">${items}</ul>`;
      }
      return `<p style="margin:0 0 10px 0">${lines.map(inlineFmt).join("<br>")}</p>`;
    })
    .join("");
  const footer = disclaimer?.trim()
    ? `<div style="margin-top:16px; padding-top:10px; border-top:1px solid #e0e0e0; font-size:8pt; color:#8a8a8a">${inlineFmt(disclaimer.trim())}</div>`
    : "";
  return `<div style="font-family:Aptos,Calibri,Arial,sans-serif; font-size:11pt; color:#242424">${body}${footer}</div>`;
}

// Markers that typically begin a quoted reply chain.
const QUOTE_MARKERS: RegExp[] = [
  /-----\s*Original Message\s*-----/i,
  /^_{5,}\s*$/m,
  // Gmail-style "…wrote:" headers, one per language TFP serves. No end-of-line
  // anchor, because some clients put the quoted text right after the colon on the
  // same line (e.g. "On … wrote: Hello…"), which a "$" would miss.
  /^On .+ wrote:/im, // EN
  /^Στις .+ έγραψε:?/im, // EL
  /^Le .+ a écrit\s*:/im, // FR
  /^Am .+ schrieb .+:/im, // DE
  /^Il giorno .+ ha scritto\s*:/im, // IT
  /^El .+ escribió\s*:/im, // ES
  /^Op .+ schreef .+:/im, // NL
  /^Em .+ escreveu\s*:/im, // PT
  // Outlook-style headers (the localized "From:" line that starts the quote).
  /^From:\s.+$/im, // EN
  /^Από:\s.+$/im, // EL
  /^De ?:\s.+$/im, // FR / ES / PT
  /^Von:\s.+$/im, // DE
  /^Da:\s.+$/im, // IT
  /^Van:\s.+$/im, // NL
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
