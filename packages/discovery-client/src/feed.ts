// Transport helpers shared by discovery and offer quoting. Isomorphic: only global
// `fetch` and `AbortController` are used, both injectable/overridable so the
// same code runs in browsers, Node, and Expo / React Native.

export interface FetchHeaders {
  get(name: string): string | null;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers?: FetchHeaders;
  text(): Promise<string>;
}

/** Minimal structural subset of `fetch` this library needs; injectable for tests/polyfills. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponse>;

export interface FetchTextOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Number of retries for HTTP 429 responses. Defaults to 0. */
  rateLimitRetries?: number;
  /** Fallback delay between 429 retries when Retry-After is absent. Defaults to 1000ms. */
  rateLimitRetryDelayMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") return fetch as unknown as FetchLike;
  throw new Error("no global fetch available; pass fetchImpl");
}

function retryAfterMs(res: FetchResponse, fallbackMs: number): number {
  const raw = res.headers?.get("retry-after");
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return fallbackMs;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const done = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** GET a URL as text with a timeout, honoring an optional caller-supplied abort signal. */
export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const doFetch = resolveFetch(opts.fetchImpl);
  const retries = opts.rateLimitRetries ?? 0;
  const fallbackDelay = opts.rateLimitRetryDelayMs ?? 1000;
  for (let attempt = 0; ; attempt++) {
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
      if (res.ok) return await res.text();
      if (res.status === 429 && attempt < retries) {
        await sleep(retryAfterMs(res, fallbackDelay), controller.signal);
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
    }
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
  /** Optional caller-owned cache for feed values, keyed by URL. */
  feedCache?: Map<string, FeedCacheEntry>;
  /** Feed cache TTL in milliseconds. Defaults to 0 (disabled). */
  feedCacheTtlMs?: number;
  /** Override current time for cache tests. Defaults to Date.now(). */
  nowMs?: number;
}

export interface FeedCacheEntry {
  value: string | number;
  expiresAt: number;
}

/**
 * Fetch a price feed URL and extract its numeric value. Feeds may return JSON
 * (`{"price":"65000.00"}`) or a bare number as text; both are handled.
 */
export async function fetchFeedValue(
  url: string,
  opts: FetchFeedOptions = {},
): Promise<string | number> {
  const ttl = opts.feedCacheTtlMs ?? 0;
  const now = opts.nowMs ?? Date.now();
  if (opts.feedCache && ttl > 0) {
    const hit = opts.feedCache.get(url);
    if (hit && hit.expiresAt > now) return hit.value;
  }
  const text = await fetchText(url, opts);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.trim();
  }
  const value = (opts.extractPrice ?? defaultPriceExtractor)(body);
  if (opts.feedCache && ttl > 0) {
    opts.feedCache.set(url, { value, expiresAt: now + ttl });
  }
  return value;
}
