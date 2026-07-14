// Transport helpers shared by discovery and swaps. Isomorphic: only global
// `fetch` and `AbortController` are used, both injectable/overridable so the
// same code runs in browsers, Node, and Expo / React Native.

/** Minimal structural subset of `fetch` this library needs; injectable for tests/polyfills. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface FetchTextOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") return fetch as unknown as FetchLike;
  throw new Error("no global fetch available; pass fetchImpl");
}

/** GET a URL as text with a timeout, honoring an optional caller-supplied abort signal. */
export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const doFetch = resolveFetch(opts.fetchImpl);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const outer = opts.signal;
  const onAbort = () => controller.abort(outer!.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}

export type PriceExtractor = (body: unknown) => string | number;

/** Default feed extractor: a bare number/string, or an object's `price` field. */
export const defaultPriceExtractor: PriceExtractor = (body) => {
  if (typeof body === "number" || typeof body === "string") return body;
  if (body !== null && typeof body === "object" && "price" in body) {
    const p = (body as Record<string, unknown>).price;
    if (typeof p === "number" || typeof p === "string") return p;
  }
  throw new Error("could not extract a price from the feed response; pass a custom extractPrice");
};

export interface FetchFeedOptions extends FetchTextOptions {
  /** Override how the numeric price is pulled out of the feed body. */
  extractPrice?: PriceExtractor;
}

/**
 * Fetch a price feed URL and extract its numeric value. Feeds may return JSON
 * (`{"price":"65000.00"}`) or a bare number as text; both are handled.
 */
export async function fetchFeedValue(
  url: string,
  opts: FetchFeedOptions = {},
): Promise<string | number> {
  const text = await fetchText(url, opts);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.trim();
  }
  return (opts.extractPrice ?? defaultPriceExtractor)(body);
}
