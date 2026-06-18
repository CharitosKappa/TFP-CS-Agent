// fetch() with a timeout and bounded retries with backoff, honoring Retry-After.
// Use ONLY for idempotent or safely-retryable requests.

export interface ResilientOptions {
  timeoutMs?: number;
  retries?: number;
  /** HTTP status codes that should trigger a retry. */
  retryOn?: number[];
}

const DEFAULTS: Required<ResilientOptions> = {
  timeoutMs: 20_000,
  retries: 3,
  retryOn: [429, 502, 503, 504],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

function backoff(attempt: number): number {
  // Exponential 0.5s → 8s, with a little jitter to avoid thundering herds.
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

export async function resilientFetch(
  url: string,
  init: RequestInit = {},
  opts: ResilientOptions = {},
): Promise<Response> {
  const { timeoutMs, retries, retryOn } = { ...DEFAULTS, ...opts };
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (retryOn.includes(res.status) && attempt < retries) {
        const wait = parseRetryAfter(res.headers.get("retry-after")) ?? backoff(attempt);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("resilientFetch: retries exhausted");
}
