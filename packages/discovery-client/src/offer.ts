// Offer quoting: human amounts in, human amounts out.
//
// `planOffer` ties the pieces together for a client that wants to fund an
// Arkade offer from either side: either "I will deposit this much" or "I want to
// receive this much". It does not perform a swap; `quoteOffer` only adds the
// price-feed fetch so the output is ready for createOffer/funding code.

import type { AssetInfo, Market } from "./types.ts";
import {
  DEFAULT_SAFETY_BPS,
  deriveAtomicPrice,
  quoteMarket,
  withinBaseLimits,
  type Direction,
  type Rational,
} from "./pricing.ts";
import { toAtomic, fromAtomic, displayPriceString } from "./assets.ts";
import { fetchFeedValue, type FetchFeedOptions } from "./feed.ts";

/** Which side of the pair the maker deposits. `base` = give base, receive quote. */
export type OfferSide = "base" | "quote";

export interface OfferAmount {
  asset: AssetInfo;
  atomic: bigint;
  display: string;
}

export interface OfferPlan {
  market: Market;
  direction: Direction;
  /** The side the maker gives. */
  give: OfferSide;
  /** What the maker sends. */
  deposit: OfferAmount;
  /** What the maker receives (the want amount to request in the offer). */
  receive: OfferAmount;
  /** Atomic price used (quote-atomic per base-atomic). */
  price: Rational;
  /** Human price (quote-display per base-display) at 8 decimals. */
  priceDisplay: string;
  safetyBps: number;
  /** The market's size limits, which always apply to the base side. */
  limits: {
    baseAsset: AssetInfo;
    minBase: OfferAmount;
    maxBase: OfferAmount;
    /** The base-side amount that was checked (deposit if base is given, else receive). */
    baseAmount: OfferAmount;
    withinLimits: boolean;
  };
}

type AmountValue = string | number | bigint;

type OfferAmountInput =
  | {
      /** Amount to give: a display string/number (converted via precision) or bigint atomic units. */
      giveAmount: AmountValue;
      wantAmount?: never;
    }
  | {
      giveAmount?: never;
      /** Amount to receive: a display string/number (converted via precision) or bigint atomic units. */
      wantAmount: AmountValue;
    };

export type PlanOfferInput = {
  market: Market;
  /** Which side the maker deposits. */
  give: OfferSide;
  /** Raw value already read from the market's `price_feed`. */
  feedValue: string | number;
  safetyBps?: number;
} & OfferAmountInput;

function amount(asset: AssetInfo, atomic: bigint): OfferAmount {
  return {
    asset,
    atomic,
    display: fromAtomic(atomic, asset.precision),
  };
}

function inputAmount(value: AmountValue, precision: number): bigint {
  return typeof value === "bigint" ? value : toAtomic(value, precision);
}

function ceilDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("cannot divide by a non-positive denominator");
  return num === 0n ? 0n : (num + den - 1n) / den;
}

function depositForWant(input: {
  wantAmount: bigint;
  direction: Direction;
  price: Rational;
  feeBps: number;
  safetyBps: number;
}): bigint {
  const netBps = 10000 - input.feeBps - input.safetyBps;
  if (netBps <= 0) {
    if (input.wantAmount === 0n) return 0n;
    throw new Error("cannot satisfy wantAmount when fee_bps + safetyBps is >= 100%");
  }
  const net = BigInt(netBps);
  if (input.direction === "baseToQuote") {
    return ceilDiv(input.wantAmount * input.price.den * 10000n, input.price.num * net);
  }
  return ceilDiv(input.wantAmount * input.price.num * 10000n, input.price.den * net);
}

/**
 * Build a fully-resolved offer plan from an already-fetched feed value. Pure and
 * synchronous. `give: "base"` deposits the base asset and receives the quote;
 * `give: "quote"` is the reverse (priced with 1/P).
 */
export function planOffer(input: PlanOfferInput): OfferPlan {
  const { market, give } = input;
  const base = market.base_asset;
  const quote = market.quote_asset;
  const depositAsset = give === "base" ? base : quote;
  const receiveAsset = give === "base" ? quote : base;
  const direction: Direction = give === "base" ? "baseToQuote" : "quoteToBase";
  const safetyBps = input.safetyBps ?? DEFAULT_SAFETY_BPS;
  const price = deriveAtomicPrice(input.feedValue, market);
  const hasGiveAmount = input.giveAmount !== undefined;
  const hasWantAmount = input.wantAmount !== undefined;
  if (hasGiveAmount === hasWantAmount) throw new Error("pass exactly one of giveAmount or wantAmount");

  let depositAtomic: bigint;
  let receiveAtomic: bigint;
  let baseAmount: bigint;

  if (hasGiveAmount) {
    depositAtomic = inputAmount(input.giveAmount, depositAsset.precision);
    const q = quoteMarket({ market, feedValue: input.feedValue, deposit: depositAtomic, direction, safetyBps });
    receiveAtomic = q.wantAmount;
    baseAmount = q.baseAmount;
  } else {
    receiveAtomic = inputAmount(input.wantAmount, receiveAsset.precision);
    depositAtomic = depositForWant({
      wantAmount: receiveAtomic,
      direction,
      price,
      feeBps: market.fee_bps,
      safetyBps,
    });
    baseAmount = direction === "baseToQuote" ? depositAtomic : receiveAtomic;
  }

  const priceDisplay = displayPriceString(price, {
    basePrecision: base.precision,
    quotePrecision: quote.precision,
  });

  return {
    market,
    direction,
    give,
    deposit: amount(depositAsset, depositAtomic),
    receive: amount(receiveAsset, receiveAtomic),
    price,
    priceDisplay,
    safetyBps,
    limits: {
      baseAsset: base,
      minBase: amount(base, BigInt(market.min_base_amount)),
      maxBase: amount(base, BigInt(market.max_base_amount)),
      baseAmount: amount(base, baseAmount),
      withinLimits: withinBaseLimits(market, baseAmount),
    },
  };
}

export type QuoteOfferOptions = FetchFeedOptions & {
  give: OfferSide;
  safetyBps?: number;
} & OfferAmountInput;

/**
 * Fetch the market's advertised `price_feed`, then build an offer plan. This
 * quotes an offer; it does not perform or submit a swap.
 */
export async function quoteOffer(market: Market, opts: QuoteOfferOptions): Promise<OfferPlan> {
  const hasGiveAmount = opts.giveAmount !== undefined;
  const hasWantAmount = opts.wantAmount !== undefined;
  if (hasGiveAmount === hasWantAmount) throw new Error("pass exactly one of giveAmount or wantAmount");
  const feedValue = await fetchFeedValue(market.price_feed, opts);
  if (hasGiveAmount) {
    return planOffer({
      market,
      give: opts.give,
      giveAmount: opts.giveAmount,
      feedValue,
      safetyBps: opts.safetyBps,
    });
  }
  return planOffer({
    market,
    give: opts.give,
    wantAmount: opts.wantAmount,
    feedValue,
    safetyBps: opts.safetyBps,
  });
}
