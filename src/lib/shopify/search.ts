// Builders for Shopify search-syntax (`query:`) values. The inputs here come from
// customer-influenced text — order numbers and emails the classifier extracted,
// product handles pulled from links — so they must be validated before being
// interpolated into a query string. Shopify's search grammar has operators
// (OR/AND, field: qualifiers, `*` wildcards, ranges); an unvalidated value like
// `* OR financial_status:paid` would broaden the search and return an unrelated
// record (first:1 then takes edges[0]) — leaking a different customer's data into
// the draft context. Each builder returns null when the value isn't well-formed,
// so the caller can skip the lookup rather than run a broadened one.

/** `name:<digits>` for an order lookup, or null if not a plain order number. */
export function orderNameQuery(orderNumber: string): string | null {
  const num = orderNumber.replace(/^#/, "").trim();
  return /^\d+$/.test(num) ? `name:${num}` : null;
}

/** Exact, quoted `email:"…"` match, or null if it isn't a plausible email. */
export function emailQuery(email: string): string | null {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/.test(e)) return null;
  return `email:"${e}"`;
}

/** Exact `handle:<slug>` match, or null if it isn't a valid product handle. */
export function handleQuery(handle: string): string | null {
  const h = handle.trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(h) ? `handle:${h}` : null;
}
