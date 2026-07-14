import { test } from "node:test";
import assert from "node:assert/strict";
import { toAtomic, fromAtomic, displayPrice, displayPriceString } from "../src/assets.ts";
import { planOffer, quoteOffer } from "../src/offer.ts";
import type { Market } from "../src/types.ts";
import { makeMarket, mockFetch } from "./helpers.ts";

// --- conversion (Arkade Assets are precision 8) ---

test("toAtomic: exact display -> atomic at precision 8", () => {
  assert.equal(toAtomic("1.5", 8), 150_000_000n);
  assert.equal(toAtomic("1", 8), 100_000_000n);
  assert.equal(toAtomic(0.01, 8), 1_000_000n);
  assert.equal(toAtomic("0.00000001", 8), 1n);
});

test("toAtomic: cross precision and rejection of over-precise amounts", () => {
  assert.equal(toAtomic("1.5", 6), 1_500_000n); // e.g. USDT
  assert.throws(() => toAtomic("1.123456789", 8), /more precision/);
  assert.throws(() => toAtomic("-1", 8), /non-negative/);
});

test("fromAtomic: atomic -> display, trimmed and untrimmed", () => {
  assert.equal(fromAtomic(150_000_000n, 8), "1.5");
  assert.equal(fromAtomic(150_000_000n, 8, { trim: false }), "1.50000000");
  assert.equal(fromAtomic(100_000_000n, 8), "1");
  assert.equal(fromAtomic(1n, 8), "0.00000001");
});

test("conversion round-trips", () => {
  for (const v of ["0.00000001", "1", "3739.84", "0.05"]) {
    assert.equal(fromAtomic(toAtomic(v, 8), 8), v);
  }
});

test("displayPrice: equal precision is identity, cross precision scales", () => {
  const p = { num: 377000n, den: 1n };
  assert.deepEqual(displayPrice(p, { basePrecision: 8, quotePrecision: 8 }), p);
  // 1 BTC = 65000 USDT => atomic price 650 (quote 6dp / base 8dp) displays as 65000.
  assert.equal(
    displayPriceString({ num: 650n, den: 1n }, { basePrecision: 8, quotePrecision: 6 }),
    "65000.00000000",
  );
});

// --- offer quotes ---

const DEPIX_ID = "4".repeat(68);

function arkadeMarket(): Market {
  return makeMarket({
    pair: "BTC/DePix",
    quote_asset: { id: DEPIX_ID, name: "Decentralized Pix", ticker: "DePix", precision: 8 },
    price_feed: "https://feed.example.com/depix",
  });
}

test("planOffer: give base, receive quote (human amounts, precision 8)", () => {
  const plan = planOffer({
    market: arkadeMarket(),
    give: "base",
    giveAmount: "0.01", // 0.01 BTC
    feedValue: "377000", // DePix per BTC
    safetyBps: 50,
  });
  assert.equal(plan.direction, "baseToQuote");
  assert.equal(plan.deposit.atomic, 1_000_000n);
  assert.equal(plan.deposit.display, "0.01");
  // floor(1_000_000 * 377000 * (10000-30-50) / 10000)
  const expected = (1_000_000n * 377000n * 9920n) / 10000n;
  assert.equal(plan.receive.atomic, expected);
  assert.equal(plan.receive.atomic, 373_984_000_000n);
  assert.equal(plan.receive.display, "3739.84");
  assert.equal(plan.receive.asset.ticker, "DePix");
  assert.equal(plan.priceDisplay, "377000.00000000");
  assert.equal(plan.limits.withinLimits, true);
  assert.equal(plan.limits.minBase.display, "0.00001"); // 1000 sats
  assert.equal(plan.limits.maxBase.display, "0.05"); // 5_000_000 sats
});

test("planOffer: give quote, receive base (reverse, priced with 1/P)", () => {
  const plan = planOffer({
    market: arkadeMarket(),
    give: "quote",
    giveAmount: "3770", // DePix
    feedValue: "377000",
    safetyBps: 50,
  });
  assert.equal(plan.direction, "quoteToBase");
  assert.equal(plan.deposit.atomic, 377_000_000_000n);
  // floor(377_000_000_000 * 9920 / (377000 * 10000)) = 992_000 sats
  assert.equal(plan.receive.atomic, 992_000n);
  assert.equal(plan.receive.display, "0.00992");
  assert.equal(plan.receive.asset.ticker, "BTC");
  assert.equal(plan.limits.withinLimits, true); // base side (received) 992_000 within [1000, 5_000_000]
});

test("planOffer: accepts a raw atomic bigint give amount", () => {
  const plan = planOffer({
    market: arkadeMarket(),
    give: "base",
    giveAmount: 1_000_000n,
    feedValue: "377000",
    safetyBps: 50,
  });
  assert.equal(plan.deposit.display, "0.01");
  assert.equal(plan.receive.atomic, 373_984_000_000n);
});

test("planOffer: can plan from a desired receive amount", () => {
  const plan = planOffer({
    market: arkadeMarket(),
    give: "base",
    wantAmount: "3739.84",
    feedValue: "377000",
    safetyBps: 50,
  });
  assert.equal(plan.deposit.atomic, 1_000_000n);
  assert.equal(plan.deposit.display, "0.01");
  assert.equal(plan.receive.atomic, 373_984_000_000n);
  assert.equal(plan.receive.display, "3739.84");
});

test("planOffer: rejects impossible wanted amounts", () => {
  assert.throws(
    () =>
      planOffer({
        market: arkadeMarket(),
        give: "base",
        wantAmount: "1",
        feedValue: "377000",
        safetyBps: 10_000,
      }),
    /cannot satisfy wantAmount/,
  );
});

test("quoteOffer: one call fetches the feed then plans (mock fetch)", async () => {
  const fetchImpl = mockFetch({
    "https://feed.example.com/depix": { body: JSON.stringify({ symbol: "BTCBRL", price: "377000" }) },
  });
  const plan = await quoteOffer(arkadeMarket(), { give: "base", giveAmount: "0.01", safetyBps: 50, fetchImpl });
  assert.equal(plan.receive.display, "3739.84");
  assert.equal(plan.receive.atomic, 373_984_000_000n);
});
