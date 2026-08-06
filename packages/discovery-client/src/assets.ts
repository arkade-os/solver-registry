// Decimals-aware amount conversion for Arkade Assets.
//
// Per the discovery spec, an asset's `decimals` (8 for BTC and most Arkade
// assets) describes how many decimals its atomic unit has and is used only for
// *rendering* — pricing math stays in atomic units. These helpers make the human⇄atomic conversion
// first-class and exact (BigInt / rational), so a UI can accept "1.5" and offer
// quotes can report human amounts without float error.

import {
  parseDecimal,
  rationalToDecimalString,
  pow10,
  type Rational,
} from "./pricing.ts";

/**
 * Convert a human display amount to atomic units for an asset with the given
 * decimals. Exact: "1.5" at 8 decimals → 150000000n. Throws if the amount is
 * finer than the asset supports (e.g. 9 decimals on an 8-decimal asset) or is
 * negative.
 */
export function toAtomic(display: string | number, decimals: number): bigint {
  const { num, den } = parseDecimal(display);
  if (num < 0n) throw new Error(`amount must be non-negative, got ${display}`);
  const scale = pow10(decimals);
  const scaledNum = num * scale;
  if (scaledNum % den !== 0n) {
    throw new Error(
      `amount ${display} has more precision than ${decimals} decimals allow`,
    );
  }
  return scaledNum / den;
}

export interface FromAtomicOptions {
  /** Trim trailing zeros in the fractional part (default true). Integers stay bare. */
  trim?: boolean;
}

/**
 * Convert atomic units to a human display string for an asset with the given
 * decimals. 150000000n at 8 decimals → "1.5" (or "1.50000000" with
 * `trim: false`). Negative inputs are supported for completeness.
 */
export function fromAtomic(
  atomic: bigint,
  decimals: number,
  opts: FromAtomicOptions = {},
): string {
  let out = rationalToDecimalString(
    { num: atomic, den: pow10(decimals) },
    decimals,
  );
  if ((opts.trim ?? true) && out.includes(".")) {
    out = out.replace(/0+$/, "").replace(/\.$/, "");
  }
  return out;
}

/** The pair's asset `decimals`, for scaling atomic prices to display prices. */
export interface PairDecimals {
  baseDecimals: number;
  quoteDecimals: number;
}

/**
 * Scale an atomic price (quote-atomic per base-atomic) to a display price
 * (quote-display per base-display): `P × 10^(baseDecimals − quoteDecimals)`.
 * For assets with equal decimals (e.g. BTC/DePix, both 8) it is the identity.
 *
 * Exact — the scaling stays a rational, so nothing rounds. Prefer this over
 * {@link displayPriceString} wherever the price is COMPUTED WITH rather than
 * shown: the string form truncates at `fractionDigits`, so a price below
 * 1e-8 renders as "0", and inverting such a rate (the give-side display of a
 * pair) turns that truncation into an error of any size. A consumer that
 * needs a number should divide this rational itself, at the precision it
 * knows it needs.
 */
export function displayPrice(
  price: Rational,
  assetDecimals: PairDecimals,
): Rational {
  const diff = assetDecimals.baseDecimals - assetDecimals.quoteDecimals;
  return diff >= 0
    ? { num: price.num * pow10(diff), den: price.den }
    : { num: price.num, den: price.den * pow10(-diff) };
}

/**
 * {@link displayPrice} rendered to a fixed-decimal string of `fractionDigits`.
 * Display only, never pricing — see displayPrice for why.
 */
export function displayPriceString(
  price: Rational,
  assetDecimals: PairDecimals,
  fractionDigits = 8,
): string {
  return rationalToDecimalString(
    displayPrice(price, assetDecimals),
    fractionDigits,
  );
}
