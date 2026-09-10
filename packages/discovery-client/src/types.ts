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
 * The rail a market side settles on. This is no longer a wire field: it is
 * the CAIP-2 chain namespace parsed off the FRONT of `AssetInfo.id`, which is
 * a CAIP-19-shaped asset type — `<chain-namespace>:<chain-reference>/<asset-
 * namespace>:<asset-reference>` (e.g. `"arkade:bitcoin/slip44:0"`,
 * `"eip155:1/erc20:0xa0b8…"`). Bundling the corridor into the id is what makes
 * the id the market's whole leg identity: two sides with the same id are the
 * same leg on the same rail on the same network, full stop, so
 * {@link marketLegKey} and {@link marketPairKey} need no separate corridor
 * component any more.
 *
 * `arkade` is the unmarked default in the sense that every spot market has it
 * on both sides. A non-arkade side makes the market a corridor (RFQ) market:
 * the two sides of the pair live on different rails (e.g. an Arkade balance
 * vs a Lightning payment or an L1 output), and the binding per-trade terms
 * arrive in the solver's quote, negotiated over the card's transports. Feed
 * metadata is unaffected by the corridor itself: only a same-underlying-asset
 * market omits the feed fields (its price is identically 1); a cross-asset
 * corridor market still advertises a feed for pre-quote planning — see
 * {@link isSameAssetMarket}.
 *
 * EVM chains are named PER CHAIN under the single `eip155` namespace, with
 * the chain id as the CAIP-2 reference (`eip155:1`, `eip155:42161`, …) —
 * never a blanket `evm` value. An ERC-20 address is unique only within a
 * chain, so a chain-blind rail would give the same token on Ethereum and on
 * an L2 the same leg key — silently collapsing two markets that cannot
 * settle each other's trades. Unlike the old per-chain enum, this needs no
 * edit here to add a chain: `eip155:<any chain id>` is already well-formed,
 * which is the point of anchoring to CAIP-2 instead of inventing a rail name
 * per chain.
 */
export const CORRIDORS = ["arkade", "bolt11", "bitcoin", "eip155"] as const;
export type Corridor = (typeof CORRIDORS)[number];
export const DEFAULT_CORRIDOR = "arkade" as const satisfies Corridor;

/**
 * Corridors that did not exist at card version 0. A card using one MUST
 * declare `version: 1`, and a consumer that understands only 0 must reject
 * such a card whole rather than skip the market it does not recognise.
 */
export const V1_CORRIDORS = ["eip155"] as const satisfies readonly Corridor[];

export function isCorridor(value: unknown): value is Corridor {
  return (CORRIDORS as readonly string[]).includes(value as string);
}

/** Inclusive upper bound on each protocol's `relays` list within a card's `transports` map. */
export const MAX_RELAYS = 8;

/** The asset descriptor's exact wire key set. Tests pin both schemas' asset definition to this. */
export const ASSET_KEYS = ["id", "name", "ticker", "decimals"] as const;

/** Inclusive upper bound for `AssetInfo.decimals`. Tests pin both schemas to this. */
export const MAX_ASSET_DECIMALS = 18;

/** Per-side asset descriptor. `id` is the canonical identity; the rest is display metadata. */
export interface AssetInfo {
  /**
   * Canonical asset identity: a CAIP-19-shaped id, `"<chain-namespace>:
   * <chain-reference>/<asset-namespace>:<asset-reference>"`, e.g.
   * `"arkade:bitcoin/slip44:0"` (BTC on Arkade mainnet), `"bolt11:bitcoin/
   * slip44:0"` (BTC over Lightning), `"arkade:bitcoin/asset:<68-hex>"` (an
   * Arkade-issued asset), or `"eip155:1/erc20:0x…"` (an ERC-20 on Ethereum
   * mainnet). The corridor is the leading chain namespace — see
   * {@link marketCorridor} — so group, price, and dedupe by this whole
   * string, never by a substring of it.
   */
  id: string;
  caip19_id?: string;
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
  /** @deprecated Legacy v0 display label; canonical cards derive it from the two asset ids. */
  pair?: string;
  base_asset: AssetInfo;
  quote_asset: AssetInfo;
  /** @deprecated Legacy v0 wire field; canonical cards encode the corridor in `base_asset.id`. */
  base_corridor?: LegacyCorridor;
  /** @deprecated Legacy v0 wire field; canonical cards encode the corridor in `quote_asset.id`. */
  quote_corridor?: LegacyCorridor;
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
 * Nostr transport config. `relays` (wss:// or ws://, 1-8) is required; the 
 * object stays open to future nostr-specific settings (e.g. per-relay read/
 * write markers) without a schema break — v0 only defines `relays`.
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
  /**
   * `0 | 1`, not `0`, and the distinction is load-bearing for consumers rather
   * than cosmetic: `validateCard` accepts both and casts its input to this type,
   * so a literal `0` here would type `card.version === 1` as unreachable and
   * `=== 0` as always true. A consumer writing the version guard this format
   * asks it to write would be compiling against a lie.
   *
   * {@link NetworkIndex} correctly keeps the literal `0` — the reducer sets that
   * field itself and no v1 index exists.
   */
  version: 0 | 1;
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
  /** @deprecated Derived from the asset ids; read those. Removed a release later. */
  pair?: string;
  /** @deprecated Derived from `base_asset.id`. */
  base_corridor?: LegacyCorridor;
  /** @deprecated Derived from `quote_asset.id`. */
  quote_corridor?: LegacyCorridor;
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
// malformed id reads as "undefined" in keys and defaults its corridor to
// arkade, rather than throwing.

type MarketLike = {
  base_asset?: unknown;
  quote_asset?: unknown;
  base_corridor?: unknown;
  quote_corridor?: unknown;
};

// The artifacts disagree on purpose while the window is open: a card's `id` is
// CAIP-19, a published index down-projects it to the v0 grammar (a v0 client
// rejects the WHOLE document otherwise, delisting every solver) and moves
// CAIP-19 to `caip19_id`. Read corridors and leg keys through here.
export function assetIdOf(value: unknown): string | undefined {
  const asset = value as AssetInfo | undefined;
  const id = typeof asset?.caip19_id === "string" ? asset.caip19_id : asset?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * The chain namespace prefixing a CAIP-19 asset id — the part before the
 * first ":" (and before the "/"). `undefined` for anything that isn't a
 * string shaped like "<namespace>:<reference>/...".
 */
function chainNamespaceOf(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const slash = id.indexOf("/");
  if (slash === -1) return undefined;
  const colon = id.indexOf(":");
  if (colon === -1 || colon > slash) return undefined;
  return id.slice(0, colon);
}

/**
 * The chain reference of a CAIP-19 asset id — the part between the first ":"
 * and the "/". For the `arkade`/`bolt11`/`bitcoin` corridors this is the
 * Arkade network the side settles on (e.g. "bitcoin", "mutinynet"); for
 * `eip155` it is the numeric EIP-155 chain id. `undefined` for anything that
 * isn't a string shaped like "<namespace>:<reference>/...".
 */
export function chainReferenceOf(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const slash = id.indexOf("/");
  if (slash === -1) return undefined;
  const colon = id.indexOf(":");
  if (colon === -1 || colon > slash) return undefined;
  return id.slice(colon + 1, slash);
}

/** Corridors whose chain reference is an Arkade network, not an external chain id. */
export const ARKADE_NETWORK_CORRIDORS = ["arkade", "bolt11", "bitcoin"] as const satisfies readonly Corridor[];

/**
 * The asset-type half of a CAIP-19 id — everything after the chain's "/",
 * i.e. "<asset-namespace>:<asset-reference>". Two ids with the same
 * underlying asset but different chain namespaces (e.g. an Arkade BTC
 * balance and a Lightning BTC payment) share this and nothing else.
 */
function underlyingAssetOf(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const slash = id.indexOf("/");
  return slash === -1 ? undefined : id.slice(slash + 1);
}

/**
 * A side's corridor. Canonical CAIP-19 ids take precedence; legacy v0 cards
 * fall back to their separate `*_corridor` fields during the compatibility
 * window.
 */
export function marketCorridor(market: MarketLike, side: Side): Corridor {
  const asset = side === "base" ? market.base_asset : market.quote_asset;
  const namespace = chainNamespaceOf(assetIdOf(asset));
  if (isCorridor(namespace)) return namespace;
  const legacy = side === "base" ? market.base_corridor : market.quote_corridor;
  if (legacy === "lightning") return "bolt11";
  if (legacy === "onchain") return "bitcoin";
  return DEFAULT_CORRIDOR;
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

// NOT the identity: v0 said "lightning"/"onchain" where CAIP-2 says
// "bolt11"/"bitcoin". `eip155` has no v0 name and self-maps — truthy and not
// "lightning", so a v0 consumer's checks exclude a rail it cannot settle.
export const LEGACY_CORRIDOR_NAMES = {
  arkade: "arkade",
  bolt11: "lightning",
  bitcoin: "onchain",
  eip155: "eip155",
} as const satisfies Record<Corridor, string>;

export type LegacyCorridor = (typeof LEGACY_CORRIDOR_NAMES)[Corridor];

export function legacyMarketCorridor(market: MarketLike, side: Side): LegacyCorridor {
  return LEGACY_CORRIDOR_NAMES[marketCorridor(market, side)];
}

export function legacyAssetId(id: string | undefined): string | undefined {
  const slash = id === undefined ? -1 : id.indexOf("/");
  if (id === undefined || slash === -1) return undefined;
  if (!(ARKADE_NETWORK_CORRIDORS as readonly string[]).includes(id.slice(0, id.indexOf(":")))) return undefined;
  const asset = id.slice(slash + 1);
  if (asset.startsWith("slip44:")) return "btc";
  return asset.startsWith("asset:") ? asset.slice("asset:".length) : undefined;
}

export function pairSideLabel(corridor: LegacyCorridor, ticker: string): string {
  return corridor === DEFAULT_CORRIDOR ? ticker : `${corridor}:${ticker}`;
}

/**
 * Whether both sides carry the same underlying asset — regardless of which
 * rail each settles on — so the price is identically 1 and no feed applies.
 * An Arkade BTC balance against a Lightning BTC payment qualifies; an Arkade
 * BTC balance against a Lightning USDT payment does not.
 * The rail (chain namespace) may differ; the chain reference may not — one
 * ERC-20 address names different tokens on different chains.
 */
export function isSameAssetMarket(market: MarketLike): boolean {
  const [baseId, quoteId] = [assetIdOf(market.base_asset), assetIdOf(market.quote_asset)];
  const base = underlyingAssetOf(baseId);
  if (base === undefined) return baseId !== undefined && baseId === quoteId;
  if (base !== underlyingAssetOf(quoteId)) return false;
  const reference = chainReferenceOf(baseId);
  return reference !== undefined && reference === chainReferenceOf(quoteId);
}

/**
 * One side's canonical leg identity. A CAIP-19 side is already complete;
 * during the compatibility window a legacy short id is qualified with its
 * separate corridor so distinct rails never collapse into one key.
 */
export function marketLegKey(market: MarketLike, side: Side): string {
  const asset = side === "base" ? market.base_asset : market.quote_asset;
  const id = assetIdOf(asset);
  return id?.includes("/") ? id : `${legacyMarketCorridor(market, side)}:${id}`;
}

/**
 * The market's canonical identity and grouping key: "<base-id>/<quote-id>".
 * This is what the reducer sorts by and clients group by: two BTC/BTC
 * markets on different corridors carry different ids and so are different
 * markets, even though nothing named a "corridor" here at all.
 */
export function marketPairKey(market: MarketLike): string {
  return `${marketLegKey(market, "base")}/${marketLegKey(market, "quote")}`;
}
