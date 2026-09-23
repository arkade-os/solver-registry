import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchIndex,
  discover,
  listMarkets,
  selectMarkets,
  bestMarket,
} from "../src/discovery.ts";
import { quoteOffer } from "../src/offer.ts";
import { registryIndexUrl } from "../src/registries.ts";
import { NETWORKS, isRfqMarket, quotesOverRfq } from "../src/types.ts";
import type { FetchLike } from "../src/feed.ts";
import { BTC, makeCorridorMarket, makeMarket, makeOneSidedMarket, mockFetch, USDT_ID as USDT } from "./helpers.ts";

const NOW = 1_700_000_100;
const GENERATED_AT = 1_700_000_000;

function idxMarket(solver: string, fee: number) {
  return { ...makeMarket({ fee_bps: fee }), solver };
}

function index(commit: string, markets: unknown[], network: string = "bitcoin") {
  return JSON.stringify({ version: 0, network, generated_at: GENERATED_AT, commit, markets });
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
  assert.equal(r.ok, true, r.error ?? "");
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

test("discover: with registries omitted, follows each network's published index and tags it as the default", async () => {
  for (const network of NETWORKS) {
    const url = registryIndexUrl(network);
    const res = await discover({
      network,
      fetchImpl: mockFetch({ [url]: { body: index("c".repeat(40), [idxMarket("alice", 30)], network) } }),
      now: NOW,
    });
    assert.deepEqual(res.markets.map((m) => m.solver), ["alice"], `${network} should follow ${url}`);
    assert.deepEqual(res.sources.map((s) => s.source), [url]);
    assert.equal(res.sources[0].fromDefault, true);
    assert.equal(res.sources[0].sourceType, "registry");
  }
});

test("discover: registries: [] opts out — no registry fetch, no default markets", async () => {
  let fetched = 0;
  const fetchImpl: FetchLike = async (url) => {
    fetched++;
    return mockFetch(routes)(url);
  };
  const res = await discover({
    registries: [],
    localCards: [{ card: daveCard() }],
    fetchImpl,
    now: NOW,
  });
  assert.equal(fetched, 0);
  assert.equal(res.markets.length, 1); // the local card still merges
  assert.equal(res.markets[0].solver, "dave");
  assert.deepEqual(res.sources.map((s) => s.sourceType), ["local"]);
});

test("discover: an explicit list overrides the default rather than merging with it", async () => {
  const res = await discover({ registries: [REG_A], fetchImpl: mockFetch(routes), now: NOW });
  assert.deepEqual(res.sources.map((s) => s.source), [REG_A]);
  assert.equal(res.sources[0].fromDefault, undefined);
});

test("discover: a failed default fetch is reported against its effective URL", async () => {
  const url = registryIndexUrl("regtest");
  const res = await discover({ network: "regtest", fetchImpl: mockFetch(routes), now: NOW });
  assert.equal(res.markets.length, 0);
  assert.equal(res.sources[0].source, url);
  assert.equal(res.sources[0].ok, false);
  assert.equal(res.sources[0].fromDefault, true);
  assert.ok(res.warnings.some((w) => w.startsWith(`${url}:`)), res.warnings.join("\n"));
});

test("discover: skips an invalid local card with a warning", async () => {
  const res = await discover({
    registries: [],
    localCards: [{ card: { version: 0, name: "Bad Name", markets: [] }, network: "bitcoin", label: "pinned" }],
    network: "bitcoin",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(res.markets.length, 0);
  assert.match(res.warnings.join("\n"), /pinned: invalid card/);
});

test("discover: projects a pinned canonical card onto short ids", async () => {
  const res = await discover({
    registries: [],
    localCards: [{ card: daveCard(), network: "bitcoin" }],
    network: "bitcoin",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(res.sources[0].ok, true, res.warnings.join("\n"));
  const market = res.markets[0];
  assert.equal(market.base_asset.id, "btc");
  assert.equal(market.base_asset.caip19_id, BTC.id);
  assert.equal(market.quote_asset.id, "a".repeat(68));
  assert.equal(market.quote_asset.caip19_id, USDT);
  assert.equal(market.pair, "BTC/USDT");
  assert.equal(market.quote_corridor, undefined);
  assert.equal(quotesOverRfq(market), false);
});

test("discover: a legacy card with a pair is copied and not re-projected", async () => {
  const quoteId = "b".repeat(68);
  const card = {
    version: 0,
    name: "legacy",
    markets: [
      {
        pair: "BTC/USDT",
        base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
        quote_asset: { id: quoteId, name: "Tether USD", ticker: "USDT", decimals: 6 },
        price_feed: FEED,
        price_feed_schema: { type: "json", price_path: "/price" },
        price_decimals: 0,
        fee_bps: 10,
        min_base_amount: "1000",
        max_base_amount: "5000000",
        min_quote_amount: "1000000",
        max_quote_amount: "1000000000000000",
      },
    ],
  };
  const res = await discover({
    registries: [],
    localCards: [{ card, network: "bitcoin" }],
    network: "bitcoin",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(res.sources[0].ok, true, res.warnings.join("\n"));
  const market = res.markets[0];
  assert.equal(market.base_asset.id, "btc");
  assert.equal(market.quote_asset.id, quoteId);
  assert.equal(market.base_asset.caip19_id, undefined);
  assert.equal(market.quote_asset.caip19_id, undefined);
  assert.equal(market.pair, "BTC/USDT");
  assert.equal("base_corridor" in market, false);
  assert.equal("quote_corridor" in market, false);
});

test("discover: a pinned card whose assets name another network skips those markets", async () => {
  const res = await discover({
    registries: [],
    localCards: [{ card: daveCard(), network: "mutinynet" }],
    network: "mutinynet",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(res.markets.length, 0);
  assert.equal(res.sources[0].ok, false);
  assert.match(res.warnings.join("\n"), /bitcoin/);
  assert.doesNotMatch(res.warnings.join("\n"), /targets/);
});

test("discover: skips a local card scoped to another network", async () => {
  const res = await discover({
    registries: [],
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
    registries: [],
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

  const best = bestMarket(res.markets, { baseId: BTC.id, quoteId: USDT });
  assert.equal(best!.solver, "dave"); // lowest fee
  assert.equal(bestMarket(res.markets, { baseId: BTC.id, quoteId: USDT, cursor: 1 })!.solver, "bob");
  assert.equal(bestMarket(res.markets, { baseId: BTC.id, quoteId: USDT, cursor: 4 }), null);
  assert.throws(() => bestMarket(res.markets, { baseId: BTC.id, quoteId: USDT, cursor: -1 }), /cursor/);

  // A want-side size filter is checked against that side's declared bounds.
  assert.equal(selectMarkets(res.markets, { baseId: BTC.id, quoteId: USDT, wantSide: "base", wantAmount: 500 }).length, 0);
  assert.equal(selectMarkets(res.markets, { baseId: BTC.id, quoteId: USDT, wantSide: "base", wantAmount: 2000 }).length, 4);
  assert.equal(selectMarkets(res.markets, { baseId: BTC.id, quoteId: "nope" }).length, 0);
  assert.throws(() => selectMarkets(res.markets, { baseId: BTC.id, quoteId: USDT, wantAmount: 2000 }), /wantSide/);

  const pairs = listMarkets(res.markets);
  assert.deepEqual(
    pairs.map((p) => ({ base: p.base_asset.ticker, quote: p.quote_asset.ticker, count: p.marketCount, solvable: p.solvable })),
    [{ base: "BTC", quote: "USDT", count: 4, solvable: { base: 4, quote: 4 } }],
  );
});

test("one-sided markets: selection and listing avoid a side no solver can pay out", async () => {
  // erin only pays out quote (serves base->quote makers); frank only pays out base.
  const erin = { version: 0, name: "erin", markets: [makeOneSidedMarket("quote", { fee_bps: 5 })] };
  const frank = { version: 0, name: "frank", markets: [makeOneSidedMarket("base", { fee_bps: 15 })] };

  const res = await discover({
    registries: [],
    localCards: [{ card: erin }, { card: frank }],
    fetchImpl: mockFetch(routes),
    now: NOW,
  });

  const pairs = listMarkets(res.markets);
  assert.deepEqual(pairs[0].solvable, { base: 1, quote: 1 });

  // Wanting quote can only be served by erin; wanting base only by frank.
  assert.equal(bestMarket(res.markets, { baseId: BTC.id, quoteId: USDT, wantSide: "quote" })!.solver, "erin");
  assert.equal(bestMarket(res.markets, { baseId: BTC.id, quoteId: USDT, wantSide: "base" })!.solver, "frank");

  // With only erin present, the base side is not solvable by any market: no pick.
  const onlyErin = res.markets.filter((m) => m.solver === "erin");
  assert.equal(bestMarket(onlyErin, { baseId: BTC.id, quoteId: USDT, wantSide: "base" }), null);
  assert.deepEqual(listMarkets(onlyErin)[0].solvable, { base: 0, quote: 1 });
});

test("corridor markets: leg-pair grouping, corridor-aware selection, transports carried through", async () => {
  // One solver quoting the same BTC/BTC asset pair over two different
  // corridors, plus a spot market — three distinct leg pairs, not one.
  const grace = {
    version: 0,
    name: "grace",
    discovery_pubkey: "d".repeat(64),
    sig: "0".repeat(128), // format-checked only; verification is the reducer's job
    transports: { nostr: { relays: ["wss://relay.example.com"] } },
    markets: [
      makeCorridorMarket("lightning", { fee_bps: 25 }),
      makeCorridorMarket("onchain", { fee_bps: 40 }),
      makeMarket({ fee_bps: 30 }),
    ],
  };
  const res = await discover({ registries: [], localCards: [{ card: grace }], fetchImpl: mockFetch(routes), now: NOW });
  assert.equal(res.markets.length, 3);

  const pairs = listMarkets(res.markets);
  assert.deepEqual(
    pairs.map((p) => ({ base: p.base_asset.ticker, quote: p.quote_asset.ticker, baseCorridor: p.base_corridor, quoteCorridor: p.quote_corridor })),
    [
      { base: "BTC", quote: "USDT", baseCorridor: "arkade", quoteCorridor: "arkade" },
      // "bitcoin:" sorts before "bolt11:" lexically, so the onchain leg pair
      // ranks first even though it was authored second.
      { base: "BTC", quote: "BTC", baseCorridor: "arkade", quoteCorridor: "bitcoin" },
      { base: "BTC", quote: "BTC", baseCorridor: "arkade", quoteCorridor: "bolt11" },
    ],
  );

  // The corridor is now baked into the id: selecting the arkade-arkade BTC/BTC
  // leg pair matches no spot market and must not silently pick a corridor one.
  assert.equal(bestMarket(res.markets, { baseId: BTC.id, quoteId: BTC.id }), null);
  const lightning = bestMarket(res.markets, { baseId: BTC.id, quoteId: "bolt11:bitcoin/slip44:0" })!;
  assert.equal(lightning.fee_bps, 25);
  assert.deepEqual(lightning.transports, { nostr: { relays: ["wss://relay.example.com"] } });
  assert.equal(bestMarket(res.markets, { baseId: BTC.id, quoteId: "bitcoin:bitcoin/slip44:0" })!.fee_bps, 40);
});

test("quotesOverRfq: a cross-asset spot market needs a pubkey and at least one relay", async () => {
  const pubkey = "d".repeat(64);
  const withRendezvous = {
    version: 0,
    name: "dave",
    discovery_pubkey: pubkey,
    transports: { nostr: { relays: ["wss://relay.example.com"] } },
    markets: [makeMarket({ fee_bps: 10 })],
  };
  const pubkeyOnly = {
    version: 0,
    name: "dave",
    discovery_pubkey: pubkey,
    markets: [makeMarket({ fee_bps: 10 })],
  };
  const quoted = await discover({
    registries: [],
    localCards: [{ card: withRendezvous }],
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(quotesOverRfq(quoted.markets[0]), true);
  assert.equal(isRfqMarket(quoted.markets[0]), false);
  const feedOnly = await discover({
    registries: [],
    localCards: [{ card: pubkeyOnly }],
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  assert.equal(quotesOverRfq(feedOnly.markets[0]), false);
  assert.equal(quotesOverRfq(makeCorridorMarket("lightning")), true);
});

test("quoteOffer: end-to-end from discovered market to exact want amount", async () => {
  const res = await discover({
    registries: [REG_A, REG_B],
    localCards: [{ card: daveCard(), network: "bitcoin" }],
    network: "bitcoin",
    fetchImpl: mockFetch(routes),
    now: NOW,
  });
  const best = bestMarket(res.markets, { baseId: BTC.id, quoteId: USDT })!;

  const plan = await quoteOffer(best, {
    give: "base",
    giveAmount: 100_000n,
    safetyBps: 50,
    fetchImpl: mockFetch(routes),
  });
  // floor(100_000 * 65000 * (10000-10-50) / 10000)
  const expected = (100_000n * 65000n * 9940n) / 10000n;
  assert.equal(plan.receive.atomic, expected);
  assert.equal(plan.receive.atomic, 6_461_000_000n);
  assert.equal(plan.limits.withinLimits, true);
});
