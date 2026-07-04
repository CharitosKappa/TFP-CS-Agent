/** ISO datetime → date-only (YYYY-MM-DD) for prompt-facing text. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}
