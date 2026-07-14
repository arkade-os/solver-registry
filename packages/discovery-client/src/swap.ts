// Easy swaps: human amounts in, human amounts out.
//
// `planSwap` ties the pieces together for a client that just wants to swap "this
// much of X for Y": it converts the given amount to atomic units via the give
// asset's precision, prices the trade in atomic units (exact), then converts the
// received `wantAmount` back to display units via the receive asset's precision,
// and reports the size limits in both units. `swap` adds the feed fetch so it is
// a single call from a discovered market to a ready-to-fund plan.

import type { AssetInfo, Market } from "./types.ts";
import { quoteMarket, type Direction, type Rational } from "./pricing.ts";
import { toAtomic, fromAtomic, displayPriceString } from "./assets.ts";
import { fetchFeedValue, type FetchFeedOptions } from "./feed.ts";

/** Which side of the pair the maker deposits. `base` = give base, receive quote. */
export type SwapSide = "base" | "quote";

export interface SwapAmount {
  asset: AssetInfo;
  atomic: bigint;
  display: string;
}

export interface SwapPlan {
  market: Market;
  direction: Direction;
  /** The side the maker gives. */
  give: SwapSide;
  /** What the maker sends. */
  deposit: SwapAmount;
  /** What the maker receives (the want amount to request in the offer). */
  receive: SwapAmount;
  /** Atomic price used (quote-atomic per base-atomic). */
  price: Rational;
  /** Human price (quote-display per base-display) at 8 decimals. */
  priceDisplay: string;
  safetyBps: number;
  /** The market's size limits, which always apply to the base side. */
  limits: {
    baseAsset: AssetInfo;
    minBase: SwapAmount;
    maxBase: SwapAmount;
    /** The base-side amount that was checked (deposit if base is given, else receive). */
    baseAmount: SwapAmount;
    withinLimits: boolean;
  };
  /** Convenience mirror of `limits.withinLimits`. */
  withinLimits: boolean;
}

export interface PlanSwapInput {
  market: Market;
  /** Which side the maker deposits. */
  give: SwapSide;
  /** Amount to give: a display string/number (converted via precision) or bigint atomic units. */
  giveAmount: string | number | bigint;
  /** Raw value already read from the market's `price_feed`. */
  feedValue: string | number;
  safetyBps?: number;
}

/**
 * Build a fully-resolved swap plan from an already-fetched feed value. Pure and
 * synchronous. `give: "base"` deposits the base asset and receives the quote;
 * `give: "quote"` is the reverse (priced with 1/P).
 */
export function planSwap(input: PlanSwapInput): SwapPlan {
  const { market, give } = input;
  const base = market.base_asset;
  const quote = market.quote_asset;
  const depositAsset = give === "base" ? base : quote;
  const receiveAsset = give === "base" ? quote : base;
  const direction: Direction = give === "base" ? "baseToQuote" : "quoteToBase";

  const depositAtomic =
    typeof input.giveAmount === "bigint"
      ? input.giveAmount
      : toAtomic(input.giveAmount, depositAsset.precision);

  const q = quoteMarket({
    market,
    feedValue: input.feedValue,
    deposit: depositAtomic,
    direction,
    safetyBps: input.safetyBps,
  });

  const priceDisplay = displayPriceString(q.price, {
    basePrecision: base.precision,
    quotePrecision: quote.precision,
  });

  const amount = (asset: AssetInfo, atomic: bigint): SwapAmount => ({
    asset,
    atomic,
    display: fromAtomic(atomic, asset.precision),
  });

  return {
    market,
    direction,
    give,
    deposit: amount(depositAsset, depositAtomic),
    receive: amount(receiveAsset, q.wantAmount),
    price: q.price,
    priceDisplay,
    safetyBps: q.safetyBps,
    limits: {
      baseAsset: base,
      minBase: amount(base, BigInt(market.min_base_amount)),
      maxBase: amount(base, BigInt(market.max_base_amount)),
      baseAmount: amount(base, q.baseAmount),
      withinLimits: q.withinLimits,
    },
    withinLimits: q.withinLimits,
  };
}

export interface SwapOptions extends FetchFeedOptions {
  give: SwapSide;
  giveAmount: string | number | bigint;
  safetyBps?: number;
}

/**
 * One-call swap: fetch the market's advertised `price_feed`, then build the plan.
 * The starting point is any discovered market (or a pinned card's market).
 */
export async function swap(market: Market, opts: SwapOptions): Promise<SwapPlan> {
  const feedValue = await fetchFeedValue(market.price_feed, opts);
  return planSwap({
    market,
    give: opts.give,
    giveAmount: opts.giveAmount,
    feedValue,
    safetyBps: opts.safetyBps,
  });
}
