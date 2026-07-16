// Exact, float-free pricing math for the maker flow.
//
// The spec is explicit: "All arithmetic over scaled integers; no floats near
// amounts." Prices are therefore carried as exact rationals (bigint num/den)
// and amounts as bigint, so a feed value like "377000.00000000" and a want
// amount of 10^14 atomic units round-trip without loss. BigInt is available in
// every target (modern browsers, Node, and Hermes / React Native).

import type { Market, Side } from "./types.ts";

/** An exact non-negative rational number. `den` is always > 0. */
export interface Rational {
  num: bigint;
  den: bigint;
}

export type Direction = "baseToQuote" | "quoteToBase";

/** Default safety cushion (bps) added to `fee_bps`, per the spec's suggested default. */
export const DEFAULT_SAFETY_BPS = 50;

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

function normalize({ num, den }: Rational): Rational {
  if (den === 0n) throw new Error("rational with zero denominator");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return g > 1n ? { num: num / g, den: den / g } : { num, den };
}

/** 10^n as an exact bigint. Shared with `assets.ts`'s precision conversion. */
export function pow10(n: number): bigint {
  if (n < 0) throw new Error(`pow10 requires n >= 0, got ${n}`);
  return 10n ** BigInt(n);
}

/**
 * Parse a decimal string or JS number into an exact rational. Accepts integers,
 * fixed-point decimals, and scientific notation (e.g. "377000.00000000",
 * "1.0002", "1.23e-4"). Numbers are stringified first so no binary-float error
 * enters the result. Throws on anything non-numeric.
 */
export function parseDecimal(value: string | number): Rational {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
    value = String(value);
  }
  const s = value.trim();
  const m = DECIMAL.exec(s);
  if (!m) throw new Error(`not a decimal number: ${JSON.stringify(value)}`);
  const [, sign, intPart = "", fracPart = "", expPart] = m;
  if (intPart === "" && fracPart === "") {
    throw new Error(`not a decimal number: ${JSON.stringify(value)}`);
  }
  // Bound magnitude so a hostile/buggy feed value (e.g. "1e2000000000") cannot
  // force a giant 10**n BigInt that hangs the client. These limits are far above
  // any real price or amount (BTC's max supply is ~16 significant digits).
  if (intPart.length + fracPart.length > 64) {
    throw new Error(`number has too many digits: ${JSON.stringify(value)}`);
  }
  const rawExp = expPart ? parseInt(expPart, 10) : 0;
  if (Math.abs(rawExp) > 1024) {
    throw new Error(`exponent out of range: ${JSON.stringify(value)}`);
  }
  const mantissa = BigInt((intPart || "0") + fracPart);
  const exp = rawExp - fracPart.length;
  const signed = sign === "-" ? -mantissa : mantissa;
  const r = exp >= 0 ? { num: signed * pow10(exp), den: 1n } : { num: signed, den: pow10(-exp) };
  return normalize(r);
}

/**
 * Derive the market price as an exact rational in quote-atomic-units per
 * base-atomic-unit, applying `price_decimals`. The feed is always advertised in
 * quote-per-base terms. Per the spec, pricing stays in atomic units and asset
 * `precision` plays no role here — `price_decimals` already encodes the
 * solver's intended scaling.
 *
 * Throws if the resulting price is not strictly positive (a zero/negative feed
 * value cannot price a trade).
 */
export function deriveAtomicPrice(
  feedValue: string | number,
  opts: Pick<Market, "price_decimals">,
): Rational {
  const f = parseDecimal(feedValue);
  // value / 10^price_decimals
  const price: Rational = normalize({ num: f.num, den: f.den * pow10(opts.price_decimals) });
  if (price.num <= 0n) throw new Error("price feed value must be positive");
  return price;
}

function toBigIntAmount(value: bigint | number | string, label: string): bigint {
  let out: bigint;
  if (typeof value === "bigint") out = value;
  else if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`${label} must be an integer amount, got ${value}`);
    out = BigInt(value);
  } else out = BigInt(value.trim());
  if (out < 0n) throw new Error(`${label} must be non-negative, got ${out}`);
  return out;
}

export interface WantAmountInput {
  /** Deposit in atomic units of the deposited side. */
  deposit: bigint | number | string;
  /** `baseToQuote`: deposit base, want quote. `quoteToBase`: deposit quote, want base. */
  direction: Direction;
  /** Price in quote-atomic per base-atomic (from `deriveAtomicPrice`). */
  price: Rational;
  feeBps: number;
  /** Client-chosen cushion; defaults to `DEFAULT_SAFETY_BPS` (50). */
  safetyBps?: number;
}

/**
 * Compute the want amount (atomic units of the received side) the maker should
 * request, conceding `fee_bps + safety_bps` from fair value. Floor division on
 * bigints keeps it exact and never rounds up in the maker's favor. Returns 0n
 * if the conceded spread is >= 100%.
 */
export function computeWantAmount(input: WantAmountInput): bigint {
  const { direction, price, feeBps } = input;
  const safetyBps = input.safetyBps ?? DEFAULT_SAFETY_BPS;
  const deposit = toBigIntAmount(input.deposit, "deposit");
  const netBps = 10000 - feeBps - safetyBps;
  if (netBps <= 0) return 0n;
  const net = BigInt(netBps);
  // baseToQuote: deposit(base) * price(quote/base) * net/10000
  // quoteToBase: deposit(quote) / price(quote/base) * net/10000  == deposit * (den/num) * net/10000
  if (direction === "baseToQuote") {
    return (deposit * price.num * net) / (price.den * 10000n);
  }
  return (deposit * price.den * net) / (price.num * 10000n);
}

/** The market fields carrying the per-side size bounds. */
export type MarketLimits = Pick<
  Market,
  "min_base_amount" | "max_base_amount" | "min_quote_amount" | "max_quote_amount"
>;

/** The side the maker receives — and the solver pays out — for a direction. */
export function wantSideOf(direction: Direction): Side {
  return direction === "baseToQuote" ? "quote" : "base";
}

/** The opposite side of a pair: what the maker receives when giving `side`. */
export function otherSide(side: Side): Side {
  return side === "base" ? "quote" : "base";
}

/**
 * A market's [min, max] bounds for one side, in that side's atomic units, or
 * null when the side is disabled (`max = 0`) — i.e. the solver cannot pay out
 * (solve) that side and makers must not take the direction that receives it.
 *
 * The only side -> field-name mapping in the client. Bounds are plain numbers;
 * bigint amounts compare exactly against them (`amount >= limits.min`), so
 * callers inline the range check rather than going through another helper.
 */
export function sideLimits(market: MarketLimits, side: Side): { min: number; max: number } | null {
  const min = side === "base" ? market.min_base_amount : market.min_quote_amount;
  const max = side === "base" ? market.max_base_amount : market.max_quote_amount;
  return max > 0 ? { min, max } : null;
}

/** Render a rational to a fixed-decimal string (for display only, never pricing). */
export function rationalToDecimalString(r: Rational, decimals = 8): string {
  const neg = r.num < 0n;
  const num = neg ? -r.num : r.num;
  const scaled = (num * pow10(decimals)) / r.den;
  const s = scaled.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? "." + s.slice(s.length - decimals) : "";
  return (neg ? "-" : "") + whole + frac;
}

export interface Quote {
  market: Market;
  direction: Direction;
  /** Deposit in atomic units of the deposited side. */
  deposit: bigint;
  /** Want amount in atomic units of the received side. */
  wantAmount: bigint;
  /** Price used, quote-atomic per base-atomic. */
  price: Rational;
  /** Human-readable price at 8 decimals (display only). */
  priceDecimalString: string;
  safetyBps: number;
  /** The side the maker receives; size limits are checked on this side. */
  wantSide: Side;
  /** Whether the want side is enabled (max > 0) — the solver can pay it out. */
  solvable: boolean;
  /** Whether `wantAmount` sits within the want side's [min, max]. Always false when not solvable. */
  withinLimits: boolean;
}

export interface QuoteInput {
  market: Market;
  /** Raw value read from the market's `price_feed`. */
  feedValue: string | number;
  deposit: bigint | number | string;
  direction: Direction;
  safetyBps?: number;
}

/**
 * Price one market from an already-fetched feed value: derive the price, compute
 * the want amount, and check the want side's size limits (the side the solver
 * pays out). Pure and synchronous — `priceMarket` in `discovery.ts` wraps this
 * with the network fetch.
 */
export function quoteMarket(input: QuoteInput): Quote {
  const { market, direction } = input;
  const safetyBps = input.safetyBps ?? DEFAULT_SAFETY_BPS;
  const deposit = toBigIntAmount(input.deposit, "deposit");
  const price = deriveAtomicPrice(input.feedValue, market);
  const wantAmount = computeWantAmount({ deposit, direction, price, feeBps: market.fee_bps, safetyBps });
  const wantSide = wantSideOf(direction);
  const limits = sideLimits(market, wantSide);
  return {
    market,
    direction,
    deposit,
    wantAmount,
    price,
    priceDecimalString: rationalToDecimalString(price, 8),
    safetyBps,
    wantSide,
    solvable: limits !== null,
    withinLimits: limits !== null && wantAmount >= limits.min && wantAmount <= limits.max,
  };
}
