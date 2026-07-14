import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchIndex,
  discover,
  listMarkets,
  selectMarkets,
  bestMarket,
  priceMarket,
} from "../src/discovery.ts";
import { makeMarket, mockFetch, USDT_ID as USDT } from "./helpers.ts";

const NOW = 1_700_000_100;
const GENERATED_AT = 1_700_000_000;

function idxMarket(solver: string, fee: number) {
  return { ...makeMarket({ fee_bps: fee }), solver };
}

function index(commit: string, markets: unknown[]) {
  return JSON.stringify({ version: 0, network: "bitcoin", generated_at: GENERATED_AT, commit, markets });
}

// Registry A: alice(30), bob(20). Registry B: alice(30) [dup], carol(25).
const REG_A = "https://reg-a.example.com/bitcoin.json";
const REG_B = "https://reg-b.example.com/bitcoin.json";
const REG_BAD = "https://reg-bad.example.com/bitcoin.json";
const FEED = "https://feed.example.com/btcusdt";

function daveCard() {
  return { version: 0, name: "dave", markets: [makeMarket({ fee_bps: 10 })] };
}

const routes = {
  [REG_A]: { body: index("a".repeat(40), [idxMarket("alice", 30), idxMarket("bob", 20)]) },
  [REG_B]: { body: index("b".repeat(40), [idxMarket("alice", 30), idxMarket("carol", 25)]) },
  [REG_BAD]: { status: 500, body: "boom" },
  [FEED]: { body: JSON.stringify({ price: "65000" }) },
};

test("fetchIndex: fetches and validates a good index with bitcoin as the default network", async () => {
  const r = await fetchIndex(REG_A, { fetchImpl: mockFetch(routes), now: NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.index!.markets.length, 2);
  assert.deepEqual(r.warnings, []);
});

test("fetchIndex: never throws on a failing registry", async () => {
  const r = await fetchIndex(REG_BAD, { network: "bitcoin", fetchImpl: mockFetch(routes), now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 500/);
});

test("fetchIndex: rejects a network mismatch", async () => {
  const r = await fetchIndex(REG_A, { network: "signet", fetchImpl: mockFetch(routes), now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error!, /expected "signet"/);
});

test("fetchIndex: flags a stale index", async () => {
  const staleNow = GENERATED_AT + 8 * 24 * 60 * 60;
  const r = await fetchIndex(REG_A, { network: "bitcoin", fetchImpl: mockFetch(routes), now: staleNow });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(" "), /stale/);
});

test("discover: merges registries + local card, dedupes, ranks; isolates failures", async () => {
  const res = await discover({
    registries: [REG_A, REG_BAD, REG_B],
    localCards: [{ card: daveCard(), network: "bitcoin" }],
    fetchImpl: mockFetch(routes),
    now: NOW,
  });

  // Ranked ascending by fee: dave(10), bob(20), carol(25), alice(30 — deduped to one).
  assert.deepEqual(
    res.markets.map((m) => m.solver),
    ["dave", "bob", "carol", "alice"],
  );
  assert.equal(res.markets.filter((m) => m.solver === "alice").length, 1);

  // Provenance is tagged.
  assert.equal(res.markets.find((m) => m.solver === "dave")!.sourceType, "local");
  assert.equal(res.markets.find((m) => m.solver === "bob")!.sourceType, "registry");

  // The bad registry failed independently.
  const bad = res.sources.find((s) => s.source === REG_BAD)!;
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /HTTP 500/);
  // ...without blocking the good ones.
  assert.equal(res.sources.filter((s) => s.ok).length, 3);
});

test("discover: skips an invalid local card with a warning", async () => {
  const res = await discover({
    localCards: [{ card: { version: 0, name: "Bad Name", markets: [] }, network: "bitcoin", label: "pinned" }],
    network: "bitcoin",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(res.markets.length, 0);
  assert.match(res.warnings.join("\n"), /pinned: invalid card/);
});

test("discover: skips a local card scoped to another network", async () => {
  const res = await discover({
    localCards: [{ card: daveCard(), network: "signet" }],
    network: "bitcoin",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(res.markets.length, 0);
  assert.match(res.warnings.join("\n"), /targets signet/);
});

test("discover: local cards inherit the default bitcoin network", async () => {
  const res = await discover({
    localCards: [{ card: daveCard() }],
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(res.markets.length, 1);
  assert.equal(res.markets[0].solver, "dave");
});

test("selectMarkets / bestMarket: filter by id pair and size, keep ranking", async () => {
  const res = await discover({
    registries: [REG_A, REG_B],
    localCards: [{ card: daveCard(), network: "bitcoin" }],
    network: "bitcoin",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });

  const best = bestMarket(res.markets, { baseId: "btc", quoteId: USDT });
  assert.equal(best!.solver, "dave"); // lowest fee
  assert.equal(bestMarket(res.markets, { baseId: "btc", quoteId: USDT, cursor: 1 })!.solver, "bob");
  assert.equal(bestMarket(res.markets, { baseId: "btc", quoteId: USDT, cursor: 4 }), null);
  assert.throws(() => bestMarket(res.markets, { baseId: "btc", quoteId: USDT, cursor: -1 }), /cursor/);

  assert.equal(selectMarkets(res.markets, { baseId: "btc", quoteId: USDT, baseAmount: 500 }).length, 0);
  assert.equal(selectMarkets(res.markets, { baseId: "btc", quoteId: USDT, baseAmount: 2000 }).length, 4);
  assert.equal(selectMarkets(res.markets, { baseId: "btc", quoteId: "nope" }).length, 0);

  const pairs = listMarkets(res.markets);
  assert.deepEqual(
    pairs.map((p) => ({ pair: p.pair, count: p.marketCount })),
    [{ pair: "BTC/USDT", count: 4 }],
  );
});

test("priceMarket: end-to-end from discovered market to exact want amount", async () => {
  const res = await discover({
    registries: [REG_A, REG_B],
    localCards: [{ card: daveCard(), network: "bitcoin" }],
    network: "bitcoin",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  const best = bestMarket(res.markets, { baseId: "btc", quoteId: USDT })!;

  const q = await priceMarket(best, {
    deposit: 100_000n,
    direction: "baseToQuote",
    safetyBps: 50,
    fetchImpl: mockFetch(routes),
  });
  // floor(100_000 * 65000 * (10000-10-50) / 10000)
  const expected = (100_000n * 65000n * 9940n) / 10000n;
  assert.equal(q.wantAmount, expected);
  assert.equal(q.wantAmount, 6_461_000_000n);
  assert.equal(q.withinLimits, true);
});
