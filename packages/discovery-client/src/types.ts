// Shared types for the discovery client.
//
// These mirror `schema/card.schema.json` and `schema/index.schema.json`, the
// on-the-wire contract this library consumes, and are the single declaration
// of the wire types — `scripts/reduce.ts` imports them from here. That import
// direction keeps this package a self-contained, portable ESM module with zero
// Node dependencies — safe to bundle for browsers and Expo / React Native.
// Keep them in sync with the schemas.

export const NETWORKS = ["bitcoin", "signet", "mutinynet", "regtest"] as const;
export type Network = (typeof NETWORKS)[number];
export const DEFAULT_NETWORK = "bitcoin" as const satisfies Network;

export function isNetwork(value: unknown): value is Network {
  return (NETWORKS as readonly string[]).includes(value as string);
}

/**
 * The corridor a market side settles on. `arkade` is the unmarked default —
 * every v0 spot market has it on both sides. A non-arkade side makes the
 * market a corridor (RFQ) market: the two sides of the pair live on
 * different rails (e.g. an Arkade balance vs a Lightning payment or an L1
 * output), and the binding per-trade terms arrive in the solver's quote,
 * negotiated over the card's transports. Feed metadata is unaffected by the
 * corridor itself: only a same-asset market omits the feed fields (its
 * price is identically 1); a cross-asset corridor market still advertises
 * a feed for pre-quote planning.
 */
export const CORRIDORS = ["arkade", "lightning", "onchain"] as const;
export type Corridor = (typeof CORRIDORS)[number];
export const DEFAULT_CORRIDOR = "arkade" as const satisfies Corridor;

export function isCorridor(value: unknown): value is Corridor {
  return (CORRIDORS as readonly string[]).includes(value as string);
}

/** The per-side corridor field names — the single side -> field mapping. */
export const CORRIDOR_KEYS = {
  base: "base_corridor",
  quote: "quote_corridor",
} as const;

/** Inclusive upper bound on each protocol's `relays` list within a card's `transports` map. */
export const MAX_RELAYS = 8;

/** The asset descriptor's exact wire key set. Tests pin both schemas' asset definition to this. */
export const ASSET_KEYS = ["id", "name", "ticker", "decimals"] as const;

/** Inclusive upper bound for `AssetInfo.decimals`. Tests pin both schemas to this. */
export const MAX_ASSET_DECIMALS = 18;

/** Per-side asset descriptor. `id` is the canonical identity; the rest is display metadata. */
export interface AssetInfo {
  /** Canonical asset identity: "btc" or a 68-hex-char AssetId. Group and price by this only. */
  id: string;
  name: string;
  ticker: string;
  /**
   * Decimals of the atomic unit (display-only; plays no role in pricing math).
   * Named after the asset registry metadata field it mirrors.
   */
  decimals: number;
}

/** How to read a numeric price from the `price_feed` response. */
export interface PriceFeedSchema {
  type: "json";
  /** RFC 6901 JSON Pointer to the numeric feed value, e.g. "/price" or "/bitcoin/usd". */
  price_path: string;
}

/** One side of a market pair. */
export type Side = "base" | "quote";

/**
 * Canonical wire encoding for atomic amounts: an unsigned decimal string with
 * no leading zeros, bounded to 30 digits. Strings keep amounts exact — JSON
 * numbers silently round past 2^53, which cannot even hold one whole token of
 * an 18-decimal asset. One canonical form also keeps card signatures stable.
 */
export const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;

/** Whether `v` is a canonical decimal-string amount (see {@link AMOUNT_PATTERN}). */
export function isAmount(v: unknown): v is string {
  return typeof v === "string" && AMOUNT_PATTERN.test(v);
}

/**
 * Canonical value identity for JSON trees: keys sorted, no whitespace. This is
 * the library's definition of market identity — discovery dedupes with it and
 * the React hook keys quote state with it, so two byte-equal markets are the
 * same market regardless of object reference.
 */
export function stableStringify(value: unknown): string {
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

/** The per-side limit field names — the single side -> field mapping. */
export const LIMIT_KEYS = {
  base: { min: "min_base_amount", max: "max_base_amount" },
  quote: { min: "min_quote_amount", max: "max_quote_amount" },
} as const;

/** A single market as advertised by a solver. */
export interface Market {
  /**
   * Display label "<base-label>/<quote-label>", where a side's label is its
   * ticker when the side's corridor is arkade and "<corridor>:<ticker>"
   * otherwise (e.g. "BTC/USDT", "BTC/lightning:BTC"). Identity is the
   * corridor-qualified leg pair — see {@link marketPairKey}.
   */
  pair: string;
  base_asset: AssetInfo;
  quote_asset: AssetInfo;
  /** The base side's corridor. Absent means "arkade" (every spot market). */
  base_corridor?: Corridor;
  /** The quote side's corridor. Absent means "arkade" (every spot market). */
  quote_corridor?: Corridor;
  /**
   * Exact URL the maker MUST price from. CORS-permissive so browsers can
   * fetch it. Required when the two sides carry different assets; MUST be
   * absent (with the other feed fields) on a same-asset corridor market,
   * whose price is identically 1 — `fee_bps` and `fee_flat` are the whole
   * price, and the executable terms arrive in the solver's RFQ quote.
   */
  price_feed?: string;
  /** Response contract for `price_feed`; clients MUST use this to extract the feed value. */
  price_feed_schema?: PriceFeedSchema;
  /** Feed value / 10^price_decimals = price in quote-atomic-units per base-atomic-unit. */
  price_decimals?: number;
  /**
   * The solver's spread, in basis points.
   *
   * NOT a sort key on its own once `fee_flat` is in play: a market with a
   * lower spread and a flat fee can be dearer than a higher-spread one at
   * small sizes and cheaper at large. Rank by the total fee at the size
   * actually being traded.
   */
  fee_bps: number;
  /**
   * The solver's flat fee as a decimal string of **quote-asset** atomic units
   * (see {@link AMOUNT_PATTERN}), or absent for none — the part of the price
   * that does not scale with size.
   *
   * Quote-asset in both directions, matching `min_quote_amount` /
   * `max_quote_amount`, so it is converted through the price when the maker
   * receives base. Optional rather than required so that adding it breaks no
   * existing card.
   */
  fee_flat?: string;
  /**
   * Per-side trade-size bounds as decimal strings of that side's atomic units
   * (see {@link AMOUNT_PATTERN}), always present. `max = "0"` disables the
   * side: the solver cannot pay it out (solve it), so makers cannot receive
   * it — `min` is then `"0"` too. An enabled side has 1 <= min <= max, and at
   * least one side is enabled.
   */
  min_base_amount: string;
  max_base_amount: string;
  min_quote_amount: string;
  max_quote_amount: string;
}

/**
 * Nostr transport config. `relays` (wss://, 1-8) is required; the object stays
 * open to future nostr-specific settings (e.g. per-relay read/write markers)
 * without a schema break — v0 only defines `relays`.
 */
export interface NostrTransport {
  relays: string[];
}

/** The v0 transport map. Nostr is the only supported protocol today. */
export interface TransportMap {
  nostr: NostrTransport;
}

/** A card is one solver's market listing for one network (what a solver PRs / a user pins). */
export interface Card {
  version: 0;
  name: string;
  discovery_pubkey?: string;
  sig?: string;
  /**
   * A dictionary of transport configs keyed by protocol (e.g. "nostr").
   * Required — along with `discovery_pubkey` and `sig` — when any market is
   * a corridor (RFQ) market: the pubkey and transports are the rendezvous makers
   * address request-for-quote messages to, so they must be self-authenticating.
   */
  transports?: TransportMap;
  markets: Market[];
}

/** A flattened market entry in a published per-network index. */
export interface IndexMarket extends Market {
  solver: string;
  discovery_pubkey?: string;
  /** The solver card's `transports` dictionary, propagated by the reducer when present. */
  transports?: TransportMap;
}

/** A published per-network index: `<base-url>/<network>.json`. */
export interface NetworkIndex {
  version: 0;
  network: Network;
  /** Unix seconds the index was generated (set by CI, used for staleness). */
  generated_at: number;
  commit: string;
  markets: IndexMarket[];
}

// Corridor helpers. All shape-defensive (they run inside validators on
// unvalidated input, so every field reads as unknown): a missing or
// malformed corridor field reads as the arkade default, and missing asset
// ids surface as "undefined" in keys rather than throwing.

type MarketLike = {
  base_asset?: unknown;
  quote_asset?: unknown;
  base_corridor?: unknown;
  quote_corridor?: unknown;
};

/** A side's corridor, defaulting the absent (and any malformed) field to arkade. */
export function marketCorridor(market: MarketLike, side: Side): Corridor {
  const raw = market[CORRIDOR_KEYS[side]];
  return isCorridor(raw) ? raw : DEFAULT_CORRIDOR;
}

/**
 * Whether any side settles off the arkade corridor. Such a market is
 * negotiated per-trade over RFQ (via the card's `discovery_pubkey` +
 * `transports`) rather than filled from the arkd stream, so the card-level
 * rendezvous fields become required.
 */
export function isRfqMarket(market: MarketLike): boolean {
  return marketCorridor(market, "base") !== DEFAULT_CORRIDOR || marketCorridor(market, "quote") !== DEFAULT_CORRIDOR;
}

function assetIdOf(value: unknown): string | undefined {
  const id = (value as AssetInfo | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

/** Whether both sides carry the same asset id — the price is identically 1 and no feed applies. */
export function isSameAssetMarket(market: MarketLike): boolean {
  const baseId = assetIdOf(market.base_asset);
  return baseId !== undefined && baseId === assetIdOf(market.quote_asset);
}

/** One side's canonical leg identity, "<corridor>:<asset-id>". */
export function marketLegKey(market: MarketLike, side: Side): string {
  const asset = side === "base" ? market.base_asset : market.quote_asset;
  return `${marketCorridor(market, side)}:${assetIdOf(asset)}`;
}

/**
 * The market's canonical identity and grouping key: the corridor-qualified
 * leg pair "<base-corridor>:<base-id>/<quote-corridor>:<quote-id>". This —
 * never the `pair` label, and no longer the bare id pair — is what the
 * reducer sorts by and clients group by: two BTC/BTC markets on different
 * corridors are different markets.
 */
export function marketPairKey(market: MarketLike): string {
  return `${marketLegKey(market, "base")}/${marketLegKey(market, "quote")}`;
}

/** A side's display label for the `pair` field: the bare ticker on the arkade corridor, "<corridor>:<ticker>" otherwise. */
export function pairSideLabel(corridor: Corridor, ticker: string): string {
  return corridor === DEFAULT_CORRIDOR ? ticker : `${corridor}:${ticker}`;
}
