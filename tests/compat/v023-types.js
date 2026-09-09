// FROZEN SNAPSHOT — DO NOT UPDATE.
//
// @arkade-os/solver-discovery 0.2.3, dist/types.js, fetched from npm 2026-09-09
// (`npm pack @arkade-os/solver-discovery@0.2.3`; tarball sha1
// 5dcbd4082cc914ec8a6da30ef1da462fb7d1f414). Verbatim except the sibling
// import path.
//
// This is the contract a deployed v0 wallet runs — arkade-os/wallet's master
// lockfile resolves @arkade-os/solver-discovery to exactly 0.2.3. The test that
// imports it asserts our published index still validates under that contract
// while the deprecation window is open.
//
// Bumping this file does NOT keep the test current: it silently changes the
// assertion from "the contract 0.2.3 shipped" to "the contract the latest
// version ships", which no deployed wallet is running, and voids the
// compatibility guarantee. 0.2.3 is immutable; so is this. Delete both files
// when the window closes.

// Shared types for the discovery client.
//
// These mirror `schema/card.schema.json` and `schema/index.schema.json`, the
// on-the-wire contract this library consumes, and are the single declaration
// of the wire types — `scripts/reduce.ts` imports them from here. That import
// direction keeps this package a self-contained, portable ESM module with zero
// Node dependencies — safe to bundle for browsers and Expo / React Native.
// Keep them in sync with the schemas.
export const NETWORKS = ["bitcoin", "signet", "mutinynet", "regtest"];
export const DEFAULT_NETWORK = "bitcoin";
export function isNetwork(value) {
    return NETWORKS.includes(value);
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
export const CORRIDORS = ["arkade", "lightning", "onchain"];
export const DEFAULT_CORRIDOR = "arkade";
export function isCorridor(value) {
    return CORRIDORS.includes(value);
}
/** The per-side corridor field names — the single side -> field mapping. */
export const CORRIDOR_KEYS = {
    base: "base_corridor",
    quote: "quote_corridor",
};
/** Inclusive upper bound on each protocol's `relays` list within a card's `transports` map. */
export const MAX_RELAYS = 8;
/** The asset descriptor's exact wire key set. Tests pin both schemas' asset definition to this. */
export const ASSET_KEYS = ["id", "name", "ticker", "decimals"];
/** Inclusive upper bound for `AssetInfo.decimals`. Tests pin both schemas to this. */
export const MAX_ASSET_DECIMALS = 18;
/**
 * Canonical wire encoding for atomic amounts: an unsigned decimal string with
 * no leading zeros, bounded to 30 digits. Strings keep amounts exact — JSON
 * numbers silently round past 2^53, which cannot even hold one whole token of
 * an 18-decimal asset. One canonical form also keeps card signatures stable.
 */
export const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
/** Whether `v` is a canonical decimal-string amount (see {@link AMOUNT_PATTERN}). */
export function isAmount(v) {
    return typeof v === "string" && AMOUNT_PATTERN.test(v);
}
/**
 * Canonical value identity for JSON trees: keys sorted, no whitespace. This is
 * the library's definition of market identity — discovery dedupes with it and
 * the React hook keys quote state with it, so two byte-equal markets are the
 * same market regardless of object reference.
 */
export function stableStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const obj = value;
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
};
/** A side's corridor, defaulting the absent (and any malformed) field to arkade. */
export function marketCorridor(market, side) {
    const raw = market[CORRIDOR_KEYS[side]];
    return isCorridor(raw) ? raw : DEFAULT_CORRIDOR;
}
/**
 * Whether any side settles off the arkade corridor. Such a market is
 * negotiated per-trade over RFQ (via the card's `discovery_pubkey` +
 * `transports`) rather than filled from the arkd stream, so the card-level
 * rendezvous fields become required.
 */
export function isRfqMarket(market) {
    return marketCorridor(market, "base") !== DEFAULT_CORRIDOR || marketCorridor(market, "quote") !== DEFAULT_CORRIDOR;
}
function assetIdOf(value) {
    const id = value?.id;
    return typeof id === "string" ? id : undefined;
}
/** Whether both sides carry the same asset id — the price is identically 1 and no feed applies. */
export function isSameAssetMarket(market) {
    const baseId = assetIdOf(market.base_asset);
    return baseId !== undefined && baseId === assetIdOf(market.quote_asset);
}
/** One side's canonical leg identity, "<corridor>:<asset-id>". */
export function marketLegKey(market, side) {
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
export function marketPairKey(market) {
    return `${marketLegKey(market, "base")}/${marketLegKey(market, "quote")}`;
}
/** A side's display label for the `pair` field: the bare ticker on the arkade corridor, "<corridor>:<ticker>" otherwise. */
export function pairSideLabel(corridor, ticker) {
    return corridor === DEFAULT_CORRIDOR ? ticker : `${corridor}:${ticker}`;
}
//# sourceMappingURL=types.js.map