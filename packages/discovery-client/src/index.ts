// @arkade/solver-discovery — a portable ESM client for discovering solver price
// feeds from Arkade solver registries. Runs in browsers, Node, and Expo /
// React Native with zero runtime dependencies (global `fetch` only).
//
// Typical flow:
//   const { markets } = await discover({ registries: [url], network: "mainnet" });
//   const market = bestMarket(markets, { baseId: "btc", quoteId: DEPIX_ID });
//   const plan   = await swap(market, { give: "base", giveAmount: "0.01" });
//   // plan.receive.display is the human amount received; plan.receive.atomic the
//   // wantAmount to request; then createOffer(...) as usual.

export {
  NETWORKS,
  isNetwork,
  type Network,
  type AssetInfo,
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
  withinBaseLimits,
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
} from "./assets.ts";

export {
  planSwap,
  swap,
  type SwapSide,
  type SwapAmount,
  type SwapPlan,
  type PlanSwapInput,
  type SwapOptions,
} from "./swap.ts";

export {
  fetchText,
  fetchFeedValue,
  defaultPriceExtractor,
  type FetchLike,
  type FetchTextOptions,
  type FetchFeedOptions,
  type PriceExtractor,
} from "./feed.ts";

export {
  fetchIndex,
  discover,
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
  type SelectOptions,
  type PriceMarketOptions,
} from "./discovery.ts";
