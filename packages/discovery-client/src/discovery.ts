// The maker-side discovery flow: fetch per-network indexes from the registries a
// client follows, merge in any user-pinned local cards, dedupe and rank, then
// price a chosen market from its advertised feed.
//
// Isomorphic by design — see `feed.ts` for the injectable transport.

import type { IndexMarket, Network, NetworkIndex } from "./types.ts";
import { validateCard, validateIndex } from "./validate.ts";
import { quoteMarket, withinBaseLimits, type Direction, type Quote } from "./pricing.ts";
import { fetchText, fetchFeedValue, type FetchLike, type FetchFeedOptions } from "./feed.ts";

export type SourceType = "registry" | "local";

/** A market plus provenance: which registry (or local card) advertised it. */
export interface DiscoveredMarket extends IndexMarket {
  source: string;
  sourceType: SourceType;
}

export const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Whether an index is older than `maxAgeSeconds` (default 7 days) relative to
 * `now` (unix seconds, default wall clock). Pure — usable on a cached index
 * without refetching.
 */
export function isIndexStale(
  index: Pick<NetworkIndex, "generated_at">,
  opts: { now?: number; maxAgeSeconds?: number } = {},
): boolean {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  return now - index.generated_at > (opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS);
}

export interface FetchIndexOptions {
  /** Expected network; a mismatched index is rejected. */
  network?: Network;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Unix seconds "now", for the staleness check. Defaults to the wall clock. */
  now?: number;
  /** Age past which an index is flagged stale. Defaults to 7 days. */
  maxAgeSeconds?: number;
}

export interface FetchIndexResult {
  url: string;
  ok: boolean;
  index?: NetworkIndex;
  /** Set when ok === false. */
  error?: string;
  warnings: string[];
}

/**
 * Fetch and validate one registry's per-network index. Never throws: transport,
 * parse, and validation failures are returned as `{ ok: false, error }` so one
 * bad registry never blocks pricing from the others.
 */
export async function fetchIndex(
  url: string,
  opts: FetchIndexOptions = {},
): Promise<FetchIndexResult> {
  const warnings: string[] = [];
  let text: string;
  try {
    text = await fetchText(url, opts);
  } catch (e) {
    return { url, ok: false, error: `fetch failed: ${(e as Error).message}`, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { url, ok: false, error: `invalid JSON: ${(e as Error).message}`, warnings };
  }

  const result = validateIndex(parsed, opts.network);
  if (!result.ok) {
    return { url, ok: false, error: `invalid index: ${result.errors.join("; ")}`, warnings };
  }

  const index = result.value!;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (isIndexStale(index, { now, maxAgeSeconds: opts.maxAgeSeconds })) {
    const ageDays = Math.floor((now - index.generated_at) / 86400);
    warnings.push(`index is stale: generated ${ageDays} day(s) ago`);
  }

  return { url, ok: true, index, warnings };
}

/** A user-pinned local card (raw JSON), scoped to a network by the user. */
export interface LocalCardInput {
  card: unknown;
  network: Network;
  /** Optional provenance label; defaults to `local:<card.name>`. */
  label?: string;
}

export interface DiscoverOptions extends FetchIndexOptions {
  /** Registry URLs to follow, in priority order (used as the ranking tiebreak). */
  registries?: string[];
  /** Locally pinned solver cards, validated against the card schema. */
  localCards?: LocalCardInput[];
  network: Network;
}

export interface SourceReport {
  source: string;
  sourceType: SourceType;
  ok: boolean;
  marketCount: number;
  error?: string;
  warnings: string[];
}

export interface DiscoverResult {
  /** Merged, deduped, ranked markets across all sources. */
  markets: DiscoveredMarket[];
  /** Per-source outcome (which registries/cards loaded, failed, or warned). */
  sources: SourceReport[];
  /** Flattened warnings across all sources (staleness, skipped cards, …). */
  warnings: string[];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function idPair(m: IndexMarket): string {
  return `${m.base_asset.id}/${m.quote_asset.id}`;
}

/** Record one source's outcome and mirror its error/warnings into the flat `warnings` list. */
function recordSource(sources: SourceReport[], warnings: string[], report: SourceReport): void {
  sources.push(report);
  if (report.error) warnings.push(`${report.source}: ${report.error}`);
  for (const w of report.warnings) warnings.push(`${report.source}: ${w}`);
}

/**
 * Discover markets across the followed registries plus any pinned local cards.
 * Registry failures are isolated; local cards are schema-validated and those
 * that fail (or target another network) are skipped with a warning. The result
 * is deduped (byte-identical entries collapsed) and ranked per id pair by
 * `fee_bps`, with source order as the tiebreak.
 */
export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const sources: SourceReport[] = [];
  const warnings: string[] = [];
  // Entries accumulate in source order (registries first, then local cards);
  // the stable sort below preserves that order within equal (pair, fee) keys,
  // which realizes the spec's "source order as tiebreak" without bookkeeping.
  const tagged: Array<{ market: IndexMarket; source: string; sourceType: SourceType }> = [];
  let contributing = 0;

  const indexResults = await Promise.all(
    (opts.registries ?? []).map((url) => fetchIndex(url, opts)),
  );

  for (const r of indexResults) {
    if (!r.ok) {
      recordSource(sources, warnings, { source: r.url, sourceType: "registry", ok: false, marketCount: 0, error: r.error, warnings: r.warnings });
      continue;
    }
    const markets = r.index!.markets;
    if (markets.length > 0) contributing++;
    for (const m of markets) tagged.push({ market: m, source: r.url, sourceType: "registry" });
    recordSource(sources, warnings, { source: r.url, sourceType: "registry", ok: true, marketCount: markets.length, warnings: r.warnings });
  }

  for (const local of opts.localCards ?? []) {
    const result = validateCard(local.card);
    if (!result.ok) {
      const source = local.label ?? "local:<invalid>";
      const error = `invalid card: ${result.errors.join("; ")}`;
      recordSource(sources, warnings, { source, sourceType: "local", ok: false, marketCount: 0, error, warnings: [] });
      continue;
    }
    const card = result.value!;
    const source = local.label ?? `local:${card.name}`;
    if (local.network !== opts.network) {
      const error = `card targets ${local.network}, not ${opts.network}; skipped`;
      recordSource(sources, warnings, { source, sourceType: "local", ok: false, marketCount: 0, error, warnings: [] });
      continue;
    }
    if (card.markets.length > 0) contributing++;
    for (const m of card.markets) {
      const entry: IndexMarket = { ...m, solver: card.name };
      if (card.discovery_pubkey) entry.discovery_pubkey = card.discovery_pubkey;
      tagged.push({ market: entry, source, sourceType: "local" });
    }
    recordSource(sources, warnings, { source, sourceType: "local", ok: true, marketCount: card.markets.length, warnings: [] });
  }

  // Drop byte-identical duplicates (same solver listed in two registries),
  // keeping the earliest source. Per the spec, entries within one source are
  // distinct by definition, so with a single contributing source there is
  // nothing to dedupe and the canonical-key pass is skipped entirely.
  let deduped = tagged;
  if (contributing > 1) {
    const seen = new Set<string>();
    deduped = tagged.filter((t) => {
      const key = stableStringify(t.market);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Precompute each entry's sort key once rather than rebuilding it on every comparison.
  const withKey = deduped.map((t) => ({ t, key: idPair(t.market) }));
  withKey.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.t.market.fee_bps - b.t.market.fee_bps;
  });

  const markets: DiscoveredMarket[] = withKey.map(({ t }) => ({ ...t.market, source: t.source, sourceType: t.sourceType }));
  return { markets, sources, warnings };
}

export interface SelectOptions {
  /** Canonical base asset id (e.g. "btc"). */
  baseId: string;
  /** Canonical quote asset id. */
  quoteId: string;
  /**
   * Optional base-side trade size (atomic units). When given, markets whose
   * [min_base_amount, max_base_amount] do not admit it are filtered out.
   */
  baseAmount?: bigint | number;
}

function selectionPredicate(opts: SelectOptions): (m: IndexMarket) => boolean {
  const amount = opts.baseAmount === undefined ? undefined : BigInt(opts.baseAmount);
  return (m) => {
    if (m.base_asset.id !== opts.baseId || m.quote_asset.id !== opts.quoteId) return false;
    return amount === undefined || withinBaseLimits(m, amount);
  };
}

/**
 * Filter already-discovered markets to one id pair (and optionally a trade
 * size), preserving discovery ranking so the first result is the best expected
 * execution. Pricing still comes from the feed; this ranking is a static proxy.
 */
export function selectMarkets<T extends IndexMarket>(markets: T[], opts: SelectOptions): T[] {
  return markets.filter(selectionPredicate(opts));
}

/** The best market for an id pair, or null if none match. Short-circuits on the first match. */
export function bestMarket<T extends IndexMarket>(markets: T[], opts: SelectOptions): T | null {
  return markets.find(selectionPredicate(opts)) ?? null;
}

export interface PriceMarketOptions extends FetchFeedOptions {
  deposit: bigint | number | string;
  direction: Direction;
  safetyBps?: number;
}

/**
 * Fetch a market's advertised `price_feed`, extract the price, and produce a
 * fully-computed {@link Quote} (want amount + limit check) in atomic units. The
 * maker MUST price from this exact URL. See `swap()` for a human-amount API.
 */
export async function priceMarket(
  market: IndexMarket,
  opts: PriceMarketOptions,
): Promise<Quote> {
  const feedValue = await fetchFeedValue(market.price_feed, opts);
  return quoteMarket({
    market,
    feedValue,
    deposit: opts.deposit,
    direction: opts.direction,
    safetyBps: opts.safetyBps,
  });
}
