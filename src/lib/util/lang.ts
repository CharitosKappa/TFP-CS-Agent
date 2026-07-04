// Common non-ISO language values the triage model sometimes emits, mapped to the
// 2-letter code the disclaimer/subject tables key on. Without this, a stray "gr"
// or "greek" would fall through to English on an otherwise-Greek reply.
const ALIASES: Record<string, string> = {
  gr: "el", gre: "el", ell: "el", greek: "el",
  ger: "de", deu: "de", german: "de",
  fre: "fr", fra: "fr", french: "fr",
  spa: "es", spanish: "es",
  dut: "nl", nld: "nl", dutch: "nl",
  por: "pt", portuguese: "pt",
  ita: "it", italian: "it",
  eng: "en", english: "en",
};

/**
 * Normalises a classifier-supplied language value to the 2-letter code our locale
 * tables use: known aliases map explicitly, otherwise take the first two letters
 * (so "pt-BR" → "pt"). Returns "" for empty input (caller falls back to English).
 */
export function normalizeLang(language?: string): string {
  const raw = (language ?? "").trim().toLowerCase();
  return ALIASES[raw] ?? raw.slice(0, 2);
}
