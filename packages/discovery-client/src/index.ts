// @arkade-os/solver-discovery — a portable ESM client for discovering solver price
// feeds from Arkade solver registries. Runs in browsers, Node, and Expo /
// React Native. The root entrypoint has zero runtime dependencies (global
// `fetch` only); the optional ./react subpath imports React.
//
// Typical flow:
//   const { markets } = await discover({ registries: [url] }); // defaults to bitcoin
//   const market = bestMarket(markets, { baseId: "btc", quoteId: DEPIX_ID, wantSide: "quote" });
//   const plan   = await quoteOffer(market, { give: "base", giveAmount: "0.01" });
//   // plan.receive.display is the human amount received; plan.receive.atomic the
//   // wantAmount to request; then createOffer(...) as usual.

export {
  NETWORKS,
  DEFAULT_NETWORK,
  AMOUNT_PATTERN,
  isAmount,
  isNetwork,
  type Network,
  type AssetInfo,
  type PriceFeedSchema,
  type Side,
  type Market,
  type Card,
  type IndexMarket,
  type NetworkIndex,
} from "./types.ts";

export {
  validateCard,
  validateIndex,
  type ValidationResult,
} from "./validate.ts";

export {
  DEFAULT_SAFETY_BPS,
  parseDecimal,
  deriveAtomicPrice,
  computeWantAmount,
  rationalToDecimalString,
  otherSide,
  sideLimits,
  quoteMarket,
  type Rational,
  type Direction,
  type WantAmountInput,
  type Quote,
  type QuoteInput,
} from "./pricing.ts";

export {
  toAtomic,
  fromAtomic,
  displayPrice,
  displayPriceString,
  type FromAtomicOptions,
  type PairDecimals,
} from "./assets.ts";

export {
  planOffer,
  quoteOffer,
  type OfferAmount,
  type OfferPlan,
  type OfferPlanLimits,
  type PlanOfferInput,
  type QuoteOfferOptions,
} from "./offer.ts";

export {
  fetchText,
  fetchFeedValue,
  parseJsonPointer,
  readJsonPointer,
  extractFeedPrice,
  type FetchLike,
  type FetchTextOptions,
  type FetchFeedOptions,
} from "./feed.ts";

export {
  fetchIndex,
  discover,
  listMarkets,
  selectMarkets,
  bestMarket,
  priceMarket,
  isIndexStale,
  DEFAULT_MAX_AGE_SECONDS,
  type SourceType,
  type DiscoveredMarket,
  type FetchIndexOptions,
  type FetchIndexResult,
  type LocalCardInput,
  type DiscoverOptions,
  type SourceReport,
  type DiscoverResult,
  type MarketPair,
  type BestMarketOptions,
  type SelectOptions,
  type PriceMarketOptions,
} from "./discovery.ts";
