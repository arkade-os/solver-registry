// The maker-side discovery flow: fetch per-network indexes from the registries a
// client follows, merge in any user-pinned local cards, dedupe and rank, then
// price a chosen market from its advertised feed.
//
// Isomorphic by design — see `feed.ts` for the injectable transport.

import {
  DEFAULT_NETWORK,
  marketCorridor,
  marketLegKey,
  marketPairKey,
  stableStringify,
  type AssetInfo,
  type Card,
  type Corridor,
  type IndexMarket,
  type IndexSolver,
  type Network,
  type NetworkIndex,
  type Side,
} from "./types.ts";
import { cardErrors, validateCard, validateIndex } from "./validate.ts";
import { verifyCardSig } from "./canonical.ts";
import { indexMarketFromCard } from "./project.ts";
import { sideLimits } from "./pricing.ts";
import { fetchText, type FetchLike } from "./feed.ts";
import { defaultRegistryUrls } from "./registries.ts";

export type SourceType = "registry" | "local";

/** A market plus provenance: which registry (or local card) advertised it. */
export interface DiscoveredMarket extends IndexMarket {
  source: string;
  sourceType: SourceType;
}

export const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Past this many max-ages a stale index vouches for no one, so a registry's removal of a solver eventually wins. */
export const STALE_LISTING_TRUST_FACTOR = 4;

/**
 * Whether an index is older than `maxAgeSeconds` (default 7 days) relative to
 * `now` (unix seconds, default wall clock). Pure — usable on an already-held index
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
  const network = opts.network ?? DEFAULT_NETWORK;
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

  const result = validateIndex(parsed, network);
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
  /** Defaults to the discovery network, which itself defaults to "bitcoin". */
  network?: Network;
  /** Optional provenance label; defaults to `local:<card.name>`. */
  label?: string;
}

/** Nostr kind of the event carrying a solver's signed card; its `d` tag is the network. */
export const SOLVER_CARD_KIND = 38859;
export const MAX_CARD_AGE_SECONDS = 7200; // four solver heartbeats of 1800 s

export interface TransportCard {
  pubkey: string;
  /** Event `created_at`, unix seconds. */
  createdAt: number;
  /** `JSON.parse(event.content)`; validated by the client, not the fetcher. */
  card: unknown;
}

export interface TransportCardFetcher {
  /** Latest event per author for this network. The fetcher authenticates DELIVERY (event signature);
   *  the client authenticates CONTENT (card signature + rules). Rejecting is allowed; resolving [] is allowed. */
  fetch(solvers: readonly IndexSolver[], network: Network): Promise<TransportCard[]>;
}

export interface DiscoverOptions extends Omit<FetchIndexOptions, "now"> {
  /** Registry URLs to follow, in priority order (the ranking tiebreak). Omitted
   *  follows the network's published index (internal, so it can move in a
   *  release); `[]` follows none; a non-empty list overrides rather than merges. */
  registries?: string[];
  /** Locally pinned solver cards, validated against the card schema. */
  localCards?: LocalCardInput[];
  /** Expected network. Defaults to "bitcoin", matching ts-sdk's DEFAULT_NETWORK_NAME. */
  network?: Network;
  /** Fetches listed solvers' signed cards; one passing every check replaces its listing's markets. */
  transportCards?: TransportCardFetcher;
  /** Unix seconds, for index staleness and card age. A plain number is still accepted. */
  now?: number | (() => number);
}

export interface SourceReport {
  source: string;
  sourceType: SourceType;
  ok: boolean;
  marketCount: number;
  error?: string;
  warnings: string[];
  /** True when the URL is the network default (no `registries` passed), not caller-named. */
  fromDefault?: boolean;
}

export interface DiscoverResult {
  /** Merged, deduped, ranked markets across all sources. */
  markets: DiscoveredMarket[];
  /** Per-source outcome; a registry `source` is the effective URL fetched, default included. */
  sources: SourceReport[];
  /** Flattened warnings across all sources (staleness, skipped cards, …). */
  warnings: string[];
}

/** Record one source's outcome and mirror its error/warnings into the flat `warnings` list. */
function recordSource(sources: SourceReport[], warnings: string[], report: SourceReport): void {
  sources.push(report);
  if (report.error) warnings.push(`${report.source}: ${report.error}`);
  for (const w of report.warnings) warnings.push(`${report.source}: ${w}`);
}

interface Listing {
  report: SourceReport;
  markets: IndexMarket[];
  solvers: IndexSolver[];
  stale?: boolean;
  /** Past STALE_LISTING_TRUST_FACTOR max-ages: its solvers were dropped too. */
  expired?: boolean;
  /** Solvers whose markets now come from their own transport card. */
  delivered?: Set<string>;
}

function transportCardRejection(delivered: TransportCard, solver: IndexSolver, network: Network, now: number): string | undefined {
  const card = delivered.card as Partial<Card> | null;
  if (typeof card !== "object" || card === null || card.discovery_pubkey !== solver.discovery_pubkey || card.name !== solver.name) {
    return "name or discovery_pubkey does not match the listing";
  }
  if (card.markets === undefined) return "a pointer carries no markets";
  if (!verifyCardSig(card)) return "sig does not verify against discovery_pubkey";
  const errors = cardErrors(card, network);
  if (errors.length > 0) return `invalid card: ${errors.join("; ")}`;
  const age = now - delivered.createdAt;
  if (!(age <= MAX_CARD_AGE_SECONDS)) return `stale: published ${age}s ago, max ${MAX_CARD_AGE_SECONDS}s`;
  // Symmetric so a skewed wallet clock still accepts live cards, while a far-future date cannot keep a dead solver listed.
  if (!(-age <= MAX_CARD_AGE_SECONDS)) return `dated ${-age}s in the future, max ${MAX_CARD_AGE_SECONDS}s`;
  return undefined;
}

/** Replaces each listing's markets with its solver's delivered card where that card passes; a failed fetch is a warning on every listing that asked. */
async function resolveTransportCards(
  listings: Listing[],
  fetcher: TransportCardFetcher,
  network: Network,
  now: number,
): Promise<void> {
  const identities = new Map<string, IndexSolver>();
  for (const { solvers } of listings) for (const solver of solvers) identities.set(stableStringify(solver), solver);
  if (identities.size === 0) return;
  let delivered: TransportCard[];
  try {
    delivered = await fetcher.fetch([...identities.values()], network);
    if (!Array.isArray(delivered)) throw new Error("fetch did not return an array");
  } catch (e) {
    const warning = `transport cards: ${e instanceof Error ? e.message : String(e)}`;
    for (const listing of listings) if (listing.solvers.length > 0) listing.report.warnings.push(warning);
    return;
  }
  const latest = new Map<string, TransportCard>();
  for (const entry of delivered) {
    // A non-number would lose every comparison, so it could shadow a real card that arrived after it.
    if (typeof entry?.pubkey !== "string" || !Number.isFinite(entry.createdAt)) continue;
    const held = latest.get(entry.pubkey);
    if (!held || entry.createdAt > held.createdAt) latest.set(entry.pubkey, entry);
  }
  for (const listing of listings) {
    for (const solver of listing.solvers) {
      const found = latest.get(solver.discovery_pubkey);
      if (!found) continue;
      const rejection = transportCardRejection(found, solver, network, now);
      if (rejection) {
        listing.report.warnings.push(`transport card for ${solver.name} ignored: ${rejection}`);
        continue;
      }
      const card = found.card as Card;
      const markets: IndexMarket[] = [];
      for (const market of card.markets ?? []) {
        const projected = indexMarketFromCard(card, market);
        if (projected.ok) markets.push(projected.market);
        else listing.report.warnings.push(`transport card for ${solver.name}: held out, no v0 asset id: ${projected.excluded}`);
      }
      listing.markets = listing.markets.filter((m) => m.solver !== solver.name).concat(markets);
      listing.report.marketCount = listing.markets.length;
      (listing.delivered ??= new Set()).add(solver.name);
    }
  }
}

// A stale index cannot vouch for the terms it snapshotted; a listed solver's own fresh signed card still can.
function holdOutStaleSnapshots(listing: Listing): void {
  if (!listing.stale) return;
  const kept = listing.markets.filter((m) => listing.delivered?.has(m.solver));
  if (kept.length === listing.markets.length) return;
  const held = listing.markets.length - kept.length;
  listing.report.warnings.push(
    listing.expired
      ? `${held} market(s) held out; the index is too old to vouch for anyone`
      : `${held} market(s) held out while the index is stale; listed solvers' fresh transport cards still count`,
  );
  listing.markets = kept;
  listing.report.marketCount = kept.length;
}

/**
 * Discover markets across the followed registries plus any pinned local cards.
 * Registry failures are isolated; local cards are schema-validated and those
 * that fail (or target another network) are skipped with a warning. The result
 * is deduped (byte-identical entries collapsed) and ranked per corridor-qualified leg pair by
 * `fee_bps`, with source order as the tiebreak.
 */
export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const network = opts.network ?? DEFAULT_NETWORK;
  // Omitted means the network default; [] is the explicit opt-out.
  const fromDefault = opts.registries === undefined;
  const registries = opts.registries ?? defaultRegistryUrls(network);
  // One reading for the index and the cards alike, taken before any fetch.
  const now = typeof opts.now === "function" ? opts.now() : (opts.now ?? Math.floor(Date.now() / 1000));
  // Entries accumulate in source order (registries first, then local cards);
  // the stable sort below preserves that order within equal (pair, fee) keys,
  // which realizes the spec's "source order as tiebreak" without bookkeeping.
  const listings: Listing[] = [];

  const indexResults = await Promise.all(
    registries.map((url) => fetchIndex(url, { ...opts, network, now })),
  );

  for (const r of indexResults) {
    const report: SourceReport = { source: r.url, sourceType: "registry", ok: r.ok, marketCount: r.ok ? r.index!.markets.length : 0, warnings: r.warnings };
    if (!r.ok) report.error = r.error;
    if (fromDefault) report.fromDefault = true;
    const maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    const stale = r.ok && isIndexStale(r.index!, { now, maxAgeSeconds });
    const expired = r.ok && isIndexStale(r.index!, { now, maxAgeSeconds: maxAgeSeconds * STALE_LISTING_TRUST_FACTOR });
    if (expired) report.warnings.push(`index too stale to vouch for its solvers: older than ${STALE_LISTING_TRUST_FACTOR}x the ${maxAgeSeconds}s max age`);
    listings.push({ report, markets: r.index?.markets ?? [], solvers: expired ? [] : (r.index?.solvers ?? []), stale, expired });
  }

  for (const local of opts.localCards ?? []) {
    const result = validateCard(local.card);
    if (!result.ok) {
      const source = local.label ?? "local:<invalid>";
      const error = `invalid card: ${result.errors.join("; ")}`;
      listings.push({ report: { source, sourceType: "local", ok: false, marketCount: 0, error, warnings: [] }, markets: [], solvers: [] });
      continue;
    }
    const card = result.value!;
    const source = local.label ?? `local:${card.name}`;
    const localNetwork = local.network ?? network;
    if (localNetwork !== network) {
      const error = `card targets ${localNetwork}, not ${network}; skipped`;
      listings.push({ report: { source, sourceType: "local", ok: false, marketCount: 0, error, warnings: [] }, markets: [], solvers: [] });
      continue;
    }
    const markets = (card.markets ?? []).map((m) => {
      const entry: IndexMarket = { ...m, solver: card.name };
      if (card.discovery_pubkey) entry.discovery_pubkey = card.discovery_pubkey;
      if (card.transports) entry.transports = card.transports;
      return entry;
    });
    const solvers: IndexSolver[] =
      card.discovery_pubkey && card.transports?.nostr
        ? [{ name: card.name, discovery_pubkey: card.discovery_pubkey, transports: card.transports }]
        : [];
    listings.push({ report: { source, sourceType: "local", ok: true, marketCount: markets.length, warnings: [] }, markets, solvers });
  }

  if (opts.transportCards) await resolveTransportCards(listings, opts.transportCards, network, now);
  for (const listing of listings) holdOutStaleSnapshots(listing);
  const sources: SourceReport[] = [];
  const warnings: string[] = [];
  for (const { report } of listings) recordSource(sources, warnings, report);
  const tagged = listings.flatMap(({ report, markets }) =>
    markets.map((market) => ({ market, source: report.source, sourceType: report.sourceType })),
  );

  // Drop byte-identical duplicates (same solver listed in two registries),
  // keeping the earliest source.
  const seen = new Set<string>();
  const deduped = tagged.filter((t) => {
    const key = stableStringify(t.market);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => {
    // Identity is the corridor-qualified leg pair — bare asset ids would
    // collapse e.g. a lightning-corridor BTC market and an onchain one.
    const [ka, kb] = [marketPairKey(a.market), marketPairKey(b.market)];
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.market.fee_bps - b.market.fee_bps;
  });

  const markets: DiscoveredMarket[] = deduped.map((t) => ({ ...t.market, source: t.source, sourceType: t.sourceType }));
  return { markets, sources, warnings };
}

export interface SelectOptions {
  /**
   * Canonical base asset id — a full CAIP-19 id, corridor and all (e.g.
   * "arkade:bitcoin/slip44:0"). The corridor is no longer a separate filter:
   * it is baked into the id, so selecting "bolt11:bitcoin/slip44:0" instead
   * of "arkade:bitcoin/slip44:0" is what used to be `baseCorridor: "lightning"`.
   */
  baseId: string;
  /** Canonical quote asset id — see `baseId`. */
  quoteId: string;
  /**
   * The side the maker wants to receive. When given, only markets with that
   * side enabled (max > 0) — able to pay it out — match, so a direction no
   * solver can fill yields no market at all.
   */
  wantSide?: Side;
  /** Trade size (atomic units) on `wantSide`, checked against that side's bounds. Requires `wantSide`. */
  wantAmount?: bigint | number;
}

export interface MarketPair {
  base_asset: AssetInfo;
  quote_asset: AssetInfo;
  /** The legs' corridors, parsed from each side's asset id (defaults resolved). */
  base_corridor: Corridor;
  quote_corridor: Corridor;
  marketCount: number;
  /**
   * How many of the pair's markets can pay out each side. A maker can only
   * receive a side whose count is > 0; UIs should not offer a direction whose
   * receive side no solver solves.
   */
  solvable: { base: number; quote: number };
}

function selectionPredicate(opts: SelectOptions): (m: IndexMarket) => boolean {
  const { wantSide } = opts;
  if (opts.wantAmount !== undefined && wantSide === undefined) {
    throw new Error("wantAmount requires wantSide");
  }
  const amount = opts.wantAmount === undefined ? undefined : BigInt(opts.wantAmount);
  return (m) => {
    if (marketLegKey(m, "base") !== opts.baseId || marketLegKey(m, "quote") !== opts.quoteId) return false;
    if (wantSide === undefined) return true;
    const limits = sideLimits(m, wantSide);
    if (limits === null) return false;
    return amount === undefined || (amount >= limits.min && amount <= limits.max);
  };
}

/**
 * Filter already-discovered markets to one leg pair (and optionally a receive
 * side and trade size), preserving discovery ranking so the first result is the
 * best expected execution. Pricing still comes from the feed; this ranking is a
 * static proxy.
 */
export function selectMarkets<T extends IndexMarket>(markets: T[], opts: SelectOptions): T[] {
  return markets.filter(selectionPredicate(opts));
}

/**
 * List available leg pairs from a ranked market set. The first market for each
 * pair supplies the display labels, `marketCount` tells UIs how many solver
 * candidates are available for that pair, and `solvable` how many can pay out
 * each side (a side at 0 cannot be traded on this pair).
 */
export function listMarkets<T extends IndexMarket>(markets: T[]): MarketPair[] {
  const byPair = new Map<string, MarketPair>();
  for (const market of markets) {
    const key = marketPairKey(market);
    let entry = byPair.get(key);
    if (!entry) {
      entry = {
        base_asset: market.base_asset,
        quote_asset: market.quote_asset,
        base_corridor: marketCorridor(market, "base"),
        quote_corridor: marketCorridor(market, "quote"),
        marketCount: 0,
        solvable: { base: 0, quote: 0 },
      };
      byPair.set(key, entry);
    }
    entry.marketCount++;
    if (sideLimits(market, "base")) entry.solvable.base++;
    if (sideLimits(market, "quote")) entry.solvable.quote++;
  }
  return [...byPair.values()];
}

export interface BestMarketOptions extends SelectOptions {
  /** Zero-based match offset. Use 1 to select the second-ranked market. */
  cursor?: number;
}

/** The best matching market, or a later match when `cursor` is set. */
export function bestMarket<T extends IndexMarket>(markets: T[], opts: BestMarketOptions): T | null {
  const cursor = opts.cursor ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error(`cursor must be a non-negative integer, got ${cursor}`);
  const matches = selectionPredicate(opts);
  let seen = 0;
  for (const market of markets) {
    if (!matches(market)) continue;
    if (seen === cursor) return market;
    seen++;
  }
  return null;
}

