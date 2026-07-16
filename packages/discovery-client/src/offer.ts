// Offer quoting: human amounts in, human amounts out.
//
// `planOffer` ties the pieces together for a client that wants to fund an
// Arkade offer from either side: either "I will deposit this much" or "I want to
// receive this much". `quoteOffer` only adds the price-feed fetch so the output
// is ready for createOffer/funding code.

import type { AssetInfo, Market, Side } from "./types.ts";
import {
  DEFAULT_SAFETY_BPS,
  computeWantAmount,
  deriveAtomicPrice,
  otherSide,
  sideLimits,
  type Direction,
  type Rational,
} from "./pricing.ts";
import { toAtomic, fromAtomic, displayPriceString } from "./assets.ts";
import { fetchFeedValue, type FetchFeedOptions } from "./feed.ts";

export interface OfferAmount {
  asset: AssetInfo;
  atomic: bigint;
  display: string;
}

/**
 * The size-limit check for a plan: applied to the side the maker receives (the
 * opposite of `plan.give`). The checked amount (and its asset) is the plan's
 * `receive`.
 */
export interface OfferPlanLimits {
  /** Bounds for the receive side; null when it is disabled (max = "0") — the market cannot pay it out. */
  min: OfferAmount | null;
  max: OfferAmount | null;
  /** Whether the received amount sits within [min, max]. Always false when the side is disabled. */
  withinLimits: boolean;
}

export interface OfferPlan {
  market: Market;
  direction: Direction;
  /** The side the maker gives. */
  give: Side;
  /** What the maker sends. */
  deposit: OfferAmount;
  /** What the maker receives (the want amount to request in the offer). */
  receive: OfferAmount;
  /** Atomic price used (quote-atomic per base-atomic). */
  price: Rational;
  /** Human price (quote-display per base-display) at 8 decimals. */
  priceDisplay: string;
  safetyBps: number;
  /** The market's size limits for the received side. */
  limits: OfferPlanLimits;
}

type AmountValue = string | number | bigint;

type OfferAmountInput =
  | {
      /** Amount to give: a display string/number (converted via the asset's decimals) or bigint atomic units. */
      giveAmount: AmountValue;
      wantAmount?: never;
    }
  | {
      giveAmount?: never;
      /** Amount to receive: a display string/number (converted via the asset's decimals) or bigint atomic units. */
      wantAmount: AmountValue;
    };

type ResolvedOfferAmount =
  | { kind: "give"; value: AmountValue }
  | { kind: "want"; value: AmountValue };

export type PlanOfferInput = {
  market: Market;
  /** Which side the maker deposits. */
  give: Side;
  /** Raw value already read from the market's `price_feed`. */
  feedValue: string | number;
  safetyBps?: number;
} & OfferAmountInput;

function amount(asset: AssetInfo, atomic: bigint): OfferAmount {
  return {
    asset,
    atomic,
    display: fromAtomic(atomic, asset.decimals),
  };
}

function inputAmount(value: AmountValue, decimals: number): bigint {
  return typeof value === "bigint" ? value : toAtomic(value, decimals);
}

function resolveOfferAmount(input: { giveAmount?: AmountValue; wantAmount?: AmountValue }): ResolvedOfferAmount {
  if (input.giveAmount !== undefined) {
    if (input.wantAmount !== undefined) throw new Error("pass exactly one of giveAmount or wantAmount");
    return { kind: "give", value: input.giveAmount };
  }
  if (input.wantAmount !== undefined) return { kind: "want", value: input.wantAmount };
  throw new Error("pass exactly one of giveAmount or wantAmount");
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
 * `give: "quote"` is the reverse (priced with 1/P). The size-limit check runs
 * on the received side — the side the solver must pay out — so a market whose
 * receive side is disabled (max = "0") reports `limits.min/max: null`.
 */
export function planOffer(input: PlanOfferInput): OfferPlan {
  const { market, give } = input;
  const base = market.base_asset;
  const quote = market.quote_asset;
  // Fail fast with the field's name: on an unvalidated market a missing or
  // non-integer decimals would otherwise surface deep in the BigInt math as an
  // opaque "Cannot convert undefined to a BigInt".
  for (const key of ["base_asset", "quote_asset"] as const) {
    const d = market[key]?.decimals;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0) {
      throw new Error(`${key}.decimals must be a non-negative integer`);
    }
  }
  const depositAsset = give === "base" ? base : quote;
  const receiveAsset = give === "base" ? quote : base;
  const direction: Direction = give === "base" ? "baseToQuote" : "quoteToBase";
  const safetyBps = input.safetyBps ?? DEFAULT_SAFETY_BPS;
  const price = deriveAtomicPrice(input.feedValue, market);
  const offerAmount = resolveOfferAmount(input);

  let depositAtomic: bigint;
  let receiveAtomic: bigint;

  if (offerAmount.kind === "give") {
    depositAtomic = inputAmount(offerAmount.value, depositAsset.decimals);
    receiveAtomic = computeWantAmount({
      deposit: depositAtomic,
      direction,
      price,
      feeBps: market.fee_bps,
      safetyBps,
    });
  } else {
    receiveAtomic = inputAmount(offerAmount.value, receiveAsset.decimals);
    depositAtomic = depositForWant({
      wantAmount: receiveAtomic,
      direction,
      price,
      feeBps: market.fee_bps,
      safetyBps,
    });
  }

  const priceDisplay = displayPriceString(price, {
    baseDecimals: base.decimals,
    quoteDecimals: quote.decimals,
  });

  const bounds = sideLimits(market, otherSide(give));
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
      min: bounds && amount(receiveAsset, bounds.min),
      max: bounds && amount(receiveAsset, bounds.max),
      withinLimits: bounds !== null && receiveAtomic >= bounds.min && receiveAtomic <= bounds.max,
    },
  };
}

export type QuoteOfferOptions = FetchFeedOptions & {
  give: Side;
  safetyBps?: number;
} & OfferAmountInput;

/**
 * Fetch the market's advertised `price_feed`, then build an offer plan. This
 * quotes an offer; it does not submit or fund anything.
 */
export async function quoteOffer(market: Market, opts: QuoteOfferOptions): Promise<OfferPlan> {
  const offerAmount = resolveOfferAmount(opts);
  const feedValue = await fetchFeedValue(market.price_feed, market.price_feed_schema, opts);
  if (offerAmount.kind === "give") {
    return planOffer({
      market,
      give: opts.give,
      giveAmount: offerAmount.value,
      feedValue,
      safetyBps: opts.safetyBps,
    });
  }
  return planOffer({
    market,
    give: opts.give,
    wantAmount: offerAmount.value,
    feedValue,
    safetyBps: opts.safetyBps,
  });
}
