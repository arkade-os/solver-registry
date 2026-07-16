import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDecimal,
  deriveAtomicPrice,
  computeWantAmount,
  pow10,
  sideLimits,
  quoteMarket,
} from "../src/pricing.ts";
import { makeMarket as market, makeOneSidedMarket } from "./helpers.ts";

test("pow10: rejects negatives, fractions, and NaN with a labeled error", () => {
  assert.throws(() => pow10(-1), /non-negative integer/);
  assert.throws(() => pow10(1.5), /non-negative integer/);
  assert.throws(() => pow10(NaN), /non-negative integer/);
});

test("parseDecimal: integers, fixed-point, scientific, signs, and numbers", () => {
  assert.deepEqual(parseDecimal("377000.00000000"), { num: 377000n, den: 1n });
  assert.deepEqual(parseDecimal("1.0002"), { num: 5001n, den: 5000n }); // 10002/10000 reduced
  assert.deepEqual(parseDecimal("0.00002"), { num: 1n, den: 50000n });
  assert.deepEqual(parseDecimal("1.23e-4"), { num: 123n, den: 1_000_000n });
  assert.deepEqual(parseDecimal("2e3"), { num: 2000n, den: 1n });
  assert.deepEqual(parseDecimal("-5"), { num: -5n, den: 1n });
  assert.deepEqual(parseDecimal(1.5), { num: 3n, den: 2n });
});

test("parseDecimal: rejects non-numeric input", () => {
  for (const bad of ["", "abc", "1.2.3", "0x10", "NaN", "1,000"]) {
    assert.throws(() => parseDecimal(bad), /not a decimal number/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseDecimal(Infinity), /finite/);
});

test("parseDecimal: bounds magnitude so a hostile feed can't force a giant BigInt", () => {
  assert.throws(() => parseDecimal("1e2000000000"), /exponent out of range/);
  assert.throws(() => parseDecimal("1e-2000000000"), /exponent out of range/);
  assert.throws(() => parseDecimal("9".repeat(65)), /too many digits/);
  // Realistic values well within the bounds still parse.
  assert.deepEqual(parseDecimal("1e18"), { num: 10n ** 18n, den: 1n });
});

test("deriveAtomicPrice: price_decimals scales the raw feed value", () => {
  // Feed reports an 8-decimal fixed-point integer for 65000.
  assert.deepEqual(deriveAtomicPrice("6500000000000", { price_decimals: 8 }), {
    num: 65000n,
    den: 1n,
  });
  // Human decimal, no extra scaling.
  assert.deepEqual(deriveAtomicPrice("377000.00000000", { price_decimals: 0 }), {
    num: 377000n,
    den: 1n,
  });
});

test("deriveAtomicPrice: rejects a zero/negative price", () => {
  assert.throws(() => deriveAtomicPrice("0", { price_decimals: 0 }), /must be positive/);
  assert.throws(() => deriveAtomicPrice("-1", { price_decimals: 0 }), /must be positive/);
});

test("sideLimits: max > 0 returns bounds, max = 0 (disabled) returns null", () => {
  const both = market();
  assert.deepEqual(sideLimits(both, "base"), { min: 1000n, max: 5_000_000n });
  assert.deepEqual(sideLimits(both, "quote"), { min: 1_000_000n, max: 1_000_000_000_000_000n });

  const quoteOnly = makeOneSidedMarket("quote"); // base bounds zeroed
  assert.equal(sideLimits(quoteOnly, "base"), null);
  assert.deepEqual(sideLimits(quoteOnly, "quote"), { min: 1_000_000n, max: 1_000_000_000_000_000n });

  // Decimal strings carry amounts JSON numbers cannot: exact past 2^53.
  const huge = market({ max_quote_amount: "9007199254740993" });
  assert.equal(sideLimits(huge, "quote")!.max, 9007199254740993n);

  // Malformed bounds from unvalidated input read as disabled, never crash.
  assert.equal(sideLimits({ ...market(), min_quote_amount: undefined } as never, "quote"), null);
  assert.equal(sideLimits({ ...market(), max_quote_amount: "1e6" } as never, "quote"), null); // non-canonical
  assert.equal(sideLimits({ ...market(), max_quote_amount: 1000 } as never, "quote"), null); // number, not string
  assert.equal(sideLimits({ ...market(), min_quote_amount: "0100" } as never, "quote"), null); // leading zero

  // Validation-rejected shapes fail closed too: a zero min on an enabled side
  // would let a dust deposit pass withinLimits with a zero receive amount, and
  // min > max is an unsatisfiable range.
  assert.equal(sideLimits(market({ min_quote_amount: "0" }), "quote"), null);
  assert.equal(sideLimits(market({ min_base_amount: "5000001", max_base_amount: "5000000" }), "base"), null);
});

test("computeWantAmount: baseToQuote concedes fee + safety and floors", () => {
  const price = { num: 65000n, den: 1n }; // quote-atomic per base-atomic
  const want = computeWantAmount({
    deposit: 100_000_000n, // 1 BTC in sats
    direction: "baseToQuote",
    price,
    feeBps: 20,
    safetyBps: 50,
  });
  const expected = (100_000_000n * 65000n * 9930n) / (1n * 10000n);
  assert.equal(want, expected);
});

test("computeWantAmount: quoteToBase is symmetric with 1/P", () => {
  const price = { num: 65000n, den: 1n };
  const want = computeWantAmount({
    deposit: 65_000_000_000n, // quote atomic units
    direction: "quoteToBase",
    price,
    feeBps: 0,
    safetyBps: 0,
  });
  const expected = (65_000_000_000n * 1n * 10000n) / (65000n * 10000n);
  assert.equal(want, expected);
});

test("computeWantAmount: exact for values beyond Number.MAX_SAFE_INTEGER", () => {
  const want = computeWantAmount({
    deposit: 10n ** 18n,
    direction: "baseToQuote",
    price: { num: 1n, den: 1n },
    feeBps: 0,
    safetyBps: 0,
  });
  assert.equal(want, 10n ** 18n);
  assert.ok(want > BigInt(Number.MAX_SAFE_INTEGER));
});

test("computeWantAmount: spread >= 100% yields zero", () => {
  const want = computeWantAmount({
    deposit: 1000n,
    direction: "baseToQuote",
    price: { num: 1n, den: 1n },
    feeBps: 9000,
    safetyBps: 1000,
  });
  assert.equal(want, 0n);
});

test("quoteMarket: end-to-end from a feed value, with limit check (in range)", () => {
  const q = quoteMarket({
    market: market({ fee_bps: 30, price_decimals: 0 }),
    feedValue: "65000",
    deposit: 100_000,
    direction: "baseToQuote",
    safetyBps: 50,
  });
  assert.equal(q.solvable, true);
  assert.equal(q.withinLimits, true);
  const expected = (100_000n * 65000n * (10000n - 30n - 50n)) / 10000n;
  assert.equal(q.wantAmount, expected);
});

test("quoteMarket: baseToQuote checks the received quote amount against quote limits", () => {
  // Raise min_quote_amount above the computed wantAmount so the trade is too small.
  const q = quoteMarket({
    market: market({ min_quote_amount: "10000000000" }),
    feedValue: "65000",
    deposit: 500, // want ~ 500 * 65000 * 0.992 = 32_240_000 < min_quote
    direction: "baseToQuote",
  });
  assert.equal(q.solvable, true);
  assert.equal(q.withinLimits, false);
});

test("quoteMarket: quoteToBase checks limits against the received base amount", () => {
  // Deposit a tiny amount of quote so the resulting base wantAmount is below min.
  const q = quoteMarket({
    market: market(),
    feedValue: "65000",
    deposit: 100, // quote atomic; wantBase ~ 100/65000 < 1 => below min
    direction: "quoteToBase",
  });
  assert.equal(q.direction, "quoteToBase");
  assert.equal(q.solvable, true);
  assert.equal(q.withinLimits, false);
});

test("quoteMarket: a direction whose want side is disabled (max = 0) is not solvable", () => {
  // The solver zeroed the quote bounds: it can only pay out base, so a maker
  // wanting quote (baseToQuote) cannot be served.
  const q = quoteMarket({
    market: makeOneSidedMarket("base"),
    feedValue: "65000",
    deposit: 100_000,
    direction: "baseToQuote",
  });
  assert.equal(q.solvable, false);
  assert.equal(q.withinLimits, false);
});
