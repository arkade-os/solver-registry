// Exact, float-free pricing math for the maker flow.
//
// The spec is explicit: "All arithmetic over scaled integers; no floats near
// amounts." Prices are therefore carried as exact rationals (bigint num/den)
// and amounts as bigint, so a feed value like "377000.00000000" and a want
// amount of 10^14 atomic units round-trip without loss. BigInt is available in
// every target (modern browsers, Node, and Hermes / React Native).

import { LIMIT_KEYS, isAmount, type Market, type Side } from "./types.ts";

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

/** 10^n as an exact bigint. Shared with `assets.ts`'s decimals conversion. */
export function pow10(n: number): bigint {
  // NaN and fractions must be caught here, not by BigInt(n): a `n < 0` check
  // alone is bypassed by NaN and the caller would see an unlabeled RangeError.
  if (!Number.isInteger(n) || n < 0) throw new Error(`pow10 requires a non-negative integer, got ${n}`);
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
 * `decimals` plays no role here — `price_decimals` already encodes the
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

/** The opposite side of a pair: what the maker receives when giving `side`. */
export function otherSide(side: Side): Side {
  return side === "base" ? "quote" : "base";
}

/**
 * A market's [min, max] bounds for one side as exact bigints of that side's
 * atomic units, or null when the side is disabled (`max = "0"`) — i.e. the
 * solver cannot pay out (solve) that side and makers must not take the
 * direction that receives it. Malformed bounds (missing, non-canonical, not a
 * decimal string) also read as disabled, so unvalidated input fails safe
 * everywhere instead of crashing or coercing in one call site but not another.
 * Callers inline the bigint range check rather than going through another
 * helper.
 */
export function sideLimits(market: Market, side: Side): { min: bigint; max: bigint } | null {
  const min = market[LIMIT_KEYS[side].min];
  const max = market[LIMIT_KEYS[side].max];
  if (!isAmount(min) || !isAmount(max) || max === "0") return null;
  const minBig = BigInt(min);
  const maxBig = BigInt(max);
  // An enabled side must satisfy 1 <= min <= max (the validator's rule). A
  // zero min would let a dust deposit pass withinLimits with a zero receive
  // amount, and min > max is an unsatisfiable range — both read as disabled.
  if (minBig === 0n || minBig > maxBig) return null;
  return { min: minBig, max: maxBig };
}

/** Render a rational to a fixed-decimal string (for display only, never pricing). */
export function rationalToDecimalString(r: Rational, fractionDigits = 8): string {
  const neg = r.num < 0n;
  const num = neg ? -r.num : r.num;
  const scaled = (num * pow10(fractionDigits)) / r.den;
  const s = scaled.toString().padStart(fractionDigits + 1, "0");
  const whole = s.slice(0, s.length - fractionDigits);
  const frac = fractionDigits > 0 ? "." + s.slice(s.length - fractionDigits) : "";
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
  /** Whether the solver can pay out the maker's receive side: enabled (max > 0) with well-formed bounds. */
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
  const limits = sideLimits(market, direction === "baseToQuote" ? "quote" : "base");
  return {
    market,
    direction,
    deposit,
    wantAmount,
    price,
    priceDecimalString: rationalToDecimalString(price, 8),
    safetyBps,
    solvable: limits !== null,
    withinLimits: limits !== null && wantAmount >= limits.min && wantAmount <= limits.max,
  };
}
