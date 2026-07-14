// Precision-aware amount conversion for Arkade Assets.
//
// Per the discovery spec, an asset's `precision` (8 for BTC and most Arkade
// assets) describes how many decimals its atomic unit carries and is used only
// for *rendering* — pricing math stays in atomic units. These helpers make the
// human⇄atomic conversion first-class and exact (BigInt / rational), so a UI can
// accept "1.5" and a swap can report human amounts without float error.

import { parseDecimal, rationalToDecimalString, pow10, type Rational } from "./pricing.ts";

/**
 * Convert a human display amount to atomic units for an asset of the given
 * precision. Exact: "1.5" at precision 8 → 150000000n. Throws if the amount is
 * finer than the asset supports (e.g. 9 decimals on an 8-decimal asset) or is
 * negative.
 */
export function toAtomic(display: string | number, precision: number): bigint {
  const { num, den } = parseDecimal(display);
  if (num < 0n) throw new Error(`amount must be non-negative, got ${display}`);
  const scale = pow10(precision);
  const scaledNum = num * scale;
  if (scaledNum % den !== 0n) {
    throw new Error(`amount ${display} has more precision than ${precision} decimals allow`);
  }
  return scaledNum / den;
}

export interface FromAtomicOptions {
  /** Trim trailing zeros in the fractional part (default true). Integers stay bare. */
  trim?: boolean;
}

/**
 * Convert atomic units to a human display string for an asset of the given
 * precision. 150000000n at precision 8 → "1.5" (or "1.50000000" with
 * `trim: false`). Negative inputs are supported for completeness.
 */
export function fromAtomic(atomic: bigint, precision: number, opts: FromAtomicOptions = {}): string {
  let out = rationalToDecimalString({ num: atomic, den: pow10(precision) }, precision);
  if ((opts.trim ?? true) && out.includes(".")) {
    out = out.replace(/0+$/, "").replace(/\.$/, "");
  }
  return out;
}

/**
 * Convert an atomic price (quote-atomic per base-atomic) to a human display
 * price (quote-display per base-display): `P × 10^(basePrecision − quotePrecision)`.
 * For equal precisions (e.g. BTC/DePix, both 8) it equals the atomic price.
 */
export function displayPrice(
  price: Rational,
  precisions: { basePrecision: number; quotePrecision: number },
): Rational {
  const diff = precisions.basePrecision - precisions.quotePrecision;
  const num = diff >= 0 ? price.num * pow10(diff) : price.num;
  const den = diff >= 0 ? price.den : price.den * pow10(-diff);
  return { num, den };
}

/** `displayPrice` rendered to a fixed-decimal string (display only). */
export function displayPriceString(
  price: Rational,
  precisions: { basePrecision: number; quotePrecision: number },
  decimals = 8,
): string {
  return rationalToDecimalString(displayPrice(price, precisions), decimals);
}
