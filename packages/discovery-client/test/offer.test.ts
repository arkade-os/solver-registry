import { test } from "node:test";
import assert from "node:assert/strict";
import { toAtomic, fromAtomic, displayPriceString } from "../src/assets.ts";
import { planOffer, quoteOffer } from "../src/offer.ts";
import type { Market } from "../src/types.ts";
import { makeCorridorMarket, makeMarket, mockFetch } from "./helpers.ts";

// --- conversion (Arkade Assets are 8-decimal) ---

test("toAtomic: exact display -> atomic at 8 decimals", () => {
  assert.equal(toAtomic("1.5", 8), 150_000_000n);
  assert.equal(toAtomic("1", 8), 100_000_000n);
  assert.equal(toAtomic(0.01, 8), 1_000_000n);
  assert.equal(toAtomic("0.00000001", 8), 1n);
});

test("toAtomic: converts across decimals and rejects over-precise amounts", () => {
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

test("displayPriceString: identity at equal decimals, scales across differing decimals", () => {
  assert.equal(
    displayPriceString({ num: 377000n, den: 1n }, { baseDecimals: 8, quoteDecimals: 8 }),
    "377000.00000000",
  );
  // 1 BTC = 65000 USDT => atomic price 650 (quote 6dp / base 8dp) displays as 65000.
  assert.equal(
    displayPriceString({ num: 650n, den: 1n }, { baseDecimals: 8, quoteDecimals: 6 }),
    "65000.00000000",
  );
});

test("planOffer: names the field when a market's asset decimals are malformed", () => {
  const m = arkadeMarket() as any;
  delete m.quote_asset.decimals;
  assert.throws(
    () => planOffer({ market: m, give: "base", giveAmount: "1", feedValue: "377000" }),
    /quote_asset\.decimals must be a non-negative integer/,
  );
});

// --- offer quotes ---

const DEPIX_ID = "4".repeat(68);

function arkadeMarket(overrides: Partial<Market> = {}): Market {
  return makeMarket({
    pair: "BTC/DePix",
    quote_asset: { id: DEPIX_ID, name: "Decentralized Pix", ticker: "DePix", decimals: 8 },
    price_feed: "https://feed.example.com/depix",
    ...overrides,
  });
}

test("planOffer: give base, receive quote (human amounts, 8 decimals)", () => {
  const plan = planOffer({
    market: arkadeMarket(),
    give: "base",
    giveAmount: "0.01", // 0.01 BTC
    feedValue: "377000", // DePix per BTC
    safetyBps: 50,
  });
  assert.equal(plan.give, "base");
  assert.equal(plan.deposit.atomic, 1_000_000n);
  assert.equal(plan.deposit.display, "0.01");
  // floor(1_000_000 * 377000 * (10000-30-50) / 10000)
  const expected = (1_000_000n * 377000n * 9920n) / 10000n;
  assert.equal(plan.receive.atomic, expected);
  assert.equal(plan.receive.atomic, 373_984_000_000n);
  assert.equal(plan.receive.display, "3739.84");
  assert.equal(plan.receive.asset.ticker, "DePix");
  assert.equal(plan.priceDisplay, "377000.00000000");
  // Limits are checked on the received (quote) side — the side the solver pays out.
  assert.equal(plan.limits.withinLimits, true);
  assert.equal(plan.limits.min!.display, "0.01"); // 1_000_000 quote atomic
  assert.equal(plan.limits.min!.asset.ticker, "DePix");
  assert.equal(plan.limits.max!.display, "10000000"); // 10^15 quote atomic
});

test("planOffer: give quote, receive base (reverse, priced with 1/P)", () => {
  const plan = planOffer({
    market: arkadeMarket(),
    give: "quote",
    giveAmount: "3770", // DePix
    feedValue: "377000",
    safetyBps: 50,
  });
  assert.equal(plan.give, "quote");
  assert.equal(plan.deposit.atomic, 377_000_000_000n);
  // floor(377_000_000_000 * 9920 / (377000 * 10000)) = 992_000 sats
  assert.equal(plan.receive.atomic, 992_000n);
  assert.equal(plan.receive.display, "0.00992");
  assert.equal(plan.receive.asset.ticker, "BTC");
  // base side (received) 992_000 within [1000, 5_000_000]
  assert.equal(plan.limits.withinLimits, true);
  assert.equal(plan.limits.min!.display, "0.00001"); // 1000 sats
  assert.equal(plan.limits.max!.display, "0.05"); // 5_000_000 sats
});

test("planOffer: a receive amount outside the receive side's bounds fails withinLimits", () => {
  // Raise min_quote_amount above the computed receive amount: the trade is too small.
  const plan = planOffer({
    market: arkadeMarket({ min_quote_amount: "10000000000" }),
    give: "base",
    giveAmount: 500n, // receive ~ 500 * 377000 * 0.992 << min_quote
    feedValue: "377000",
    safetyBps: 50,
  });
  assert.equal(plan.limits.min!.atomic, 10_000_000_000n);
  assert.equal(plan.limits.withinLimits, false);
});

test("planOffer: a disabled receive side yields null bounds and never passes limits", () => {
  // The solver only pays out quote; a maker giving quote (receiving base) can't be served.
  const plan = planOffer({
    market: arkadeMarket({ min_base_amount: "0", max_base_amount: "0" }),
    give: "quote",
    giveAmount: "3770",
    feedValue: "377000",
    safetyBps: 50,
  });
  assert.equal(plan.limits.min, null);
  assert.equal(plan.limits.max, null);
  assert.equal(plan.limits.withinLimits, false);
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

test("planOffer: a same-asset corridor market prices at exactly 1, conceding only the spread", () => {
  const plan = planOffer({
    market: makeCorridorMarket("lightning", { fee_bps: 25 }),
    give: "base",
    giveAmount: 100_000n,
    safetyBps: 50,
  });
  // floor(100_000 * 1 * (10000 - 25 - 50) / 10000)
  assert.equal(plan.receive.atomic, 99_250n);
  assert.equal(plan.priceDisplay, "1.00000000");
  assert.equal(plan.limits.withinLimits, true);
});

test("planOffer: still demands a feed value for a cross-asset market", () => {
  assert.throws(
    () => planOffer({ market: makeMarket(), give: "base", giveAmount: 100_000n }),
    /needs feedValue/,
  );
});

test("quoteOffer: fetches nothing for a same-asset corridor market", async () => {
  // An empty route table 404s any fetch, so success proves nothing was fetched.
  const plan = await quoteOffer(makeCorridorMarket("onchain", { fee_bps: 40 }), {
    give: "base",
    giveAmount: 100_000n,
    safetyBps: 0,
    fetchImpl: mockFetch({}),
  });
  // floor(100_000 * (10000 - 40) / 10000)
  assert.equal(plan.receive.atomic, 99_600n);
});
