// Shared types for the discovery client.
//
// These mirror `schema/card.schema.json` and `schema/index.schema.json`, the
// on-the-wire contract this library consumes, and are the single declaration
// of the wire types — `scripts/reduce.ts` imports them from here. That import
// direction keeps this package a self-contained, portable ESM module with zero
// Node dependencies — safe to bundle for browsers and Expo / React Native.
// Keep them in sync with the schemas.

export const NETWORKS = ["bitcoin", "signet", "mutinynet"] as const;
export type Network = (typeof NETWORKS)[number];
export const DEFAULT_NETWORK = "bitcoin" as const satisfies Network;

export function isNetwork(value: unknown): value is Network {
  return (NETWORKS as readonly string[]).includes(value as string);
}

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
  /** Display label "<base-ticker>/<quote-ticker>"; identity is (base_asset.id, quote_asset.id). */
  pair: string;
  base_asset: AssetInfo;
  quote_asset: AssetInfo;
  /** Exact URL the maker MUST price from. CORS-permissive so browsers can fetch it. */
  price_feed: string;
  /** Response contract for `price_feed`; clients MUST use this to extract the feed value. */
  price_feed_schema: PriceFeedSchema;
  /** Feed value / 10^price_decimals = price in quote-atomic-units per base-atomic-unit. */
  price_decimals: number;
  /** The solver's spread, in basis points. Sort key: lower is better expected execution. */
  fee_bps: number;
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

/** A card is one solver's market listing for one network (what a solver PRs / a user pins). */
export interface Card {
  version: 0;
  name: string;
  discovery_pubkey?: string;
  sig?: string;
  markets: Market[];
}

/** A flattened market entry in a published per-network index. */
export interface IndexMarket extends Market {
  solver: string;
  discovery_pubkey?: string;
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
