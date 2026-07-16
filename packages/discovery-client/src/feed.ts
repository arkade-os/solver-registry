// Transport helpers shared by discovery and offer quoting. Isomorphic: only global
// `fetch` and `AbortController` are used, both injectable/overridable so the
// same code runs in browsers, Node, and Expo / React Native.

import type { PriceFeedSchema } from "./types.ts";

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Minimal structural subset of `fetch` this library needs; injectable for tests/polyfills. */
export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<FetchResponse>;

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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outer = opts.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  const abortPromise = outer
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(outer.reason instanceof Error ? outer.reason : new Error("aborted"));
        if (outer.aborted) onAbort();
        else outer.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  try {
    const res = await Promise.race([doFetch(url), timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
    if (outer && onAbort) outer.removeEventListener("abort", onAbort);
  }
}

const JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;

function isNumericFeedValue(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

export function parseJsonPointer(pointer: string): string[] {
  if (!JSON_POINTER.test(pointer)) {
    throw new Error(`invalid JSON Pointer: ${JSON.stringify(pointer)}`);
  }
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function readJsonPointer(body: unknown, pointer: string): unknown {
  let value = body;
  for (const token of parseJsonPointer(pointer)) {
    if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, token)) {
      throw new Error(`price path ${JSON.stringify(pointer)} not found in feed response`);
    }
    value = (value as Record<string, unknown>)[token];
  }
  return value;
}

export function extractFeedPrice(body: unknown, schema: PriceFeedSchema): string | number {
  if (schema.type !== "json") throw new Error(`unsupported price feed schema type: ${schema.type}`);
  const value = readJsonPointer(body, schema.price_path);
  if (!isNumericFeedValue(value)) {
    throw new Error(`price path ${JSON.stringify(schema.price_path)} did not resolve to a numeric value`);
  }
  return value;
}

export type FetchFeedOptions = FetchTextOptions;

/**
 * Fetch a price feed URL and extract its numeric value. Feeds may return JSON
 * objects (e.g. `{"price":"65000.00"}`) or a bare JSON number/string. The
 * market's `price_feed_schema.price_path` selects the scalar value.
 */
export async function fetchFeedValue(
  url: string,
  schema: PriceFeedSchema,
  opts: FetchFeedOptions = {},
): Promise<string | number> {
  const text = await fetchText(url, opts);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`price feed response is not JSON: ${(err as Error).message}`);
  }
  return extractFeedPrice(body, schema);
}
