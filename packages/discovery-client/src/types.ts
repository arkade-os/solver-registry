// Shared types for the discovery client.
//
// These mirror `schema/card.schema.json` and `schema/index.schema.json`, the
// on-the-wire contract this library consumes. They are redeclared here (rather
// than imported from `scripts/reduce.ts`) so the client stays a self-contained,
// portable ESM module with zero Node dependencies — safe to bundle for browsers
// and Expo / React Native. Keep them in sync with the schemas.

export const NETWORKS = ["mainnet", "signet", "mutinynet"] as const;
export type Network = (typeof NETWORKS)[number];

export function isNetwork(value: unknown): value is Network {
  return (NETWORKS as readonly string[]).includes(value as string);
}

/** Per-side asset descriptor. `id` is the canonical identity; the rest is display metadata. */
export interface AssetInfo {
  /** Canonical asset identity: "btc" or a 68-hex-char AssetId. Group and price by this only. */
  id: string;
  name: string;
  ticker: string;
  /** Decimals of the atomic unit (display-only; plays no role in pricing math). */
  precision: number;
}

/** A single market as advertised by a solver. */
export interface Market {
  /** Display label "<base-ticker>/<quote-ticker>"; identity is (base_asset.id, quote_asset.id). */
  pair: string;
  base_asset: AssetInfo;
  quote_asset: AssetInfo;
  /** Exact URL the maker MUST price from. CORS-permissive so browsers can fetch it. */
  price_feed: string;
  /** How to normalize the feed value to quote-atomic-units per base-atomic-unit. */
  price_decimals: number;
  invert: boolean;
  /** The solver's spread, in basis points. Sort key: lower is better expected execution. */
  fee_bps: number;
  /** Trade-size bounds in base-asset atomic units, applied to the base side regardless of direction. */
  min_base_amount: number;
  max_base_amount: number;
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
