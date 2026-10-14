import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchIndex,
  discover,
  listMarkets,
  selectMarkets,
  bestMarket,
  MAX_CARD_AGE_SECONDS,
  type TransportCard,
  type TransportCardFetcher,
} from "../src/discovery.ts";
import { quoteOffer } from "../src/offer.ts";
import { registryIndexUrl } from "../src/registries.ts";
import { NETWORKS, type IndexSolver } from "../src/types.ts";
import type { FetchLike } from "../src/feed.ts";
import { BTC, KEYS, makeCorridorMarket, makeMarket, makeOneSidedMarket, mockFetch, signed, USDT_ID as USDT } from "./helpers.ts";

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

// carol is a full card listed at fee 25; pat is a pointer with nothing in markets.
const [CAROL, PAT, EVE] = KEYS;
const REG_T = "https://reg-t.example.com/bitcoin.json";
const RELAYS = { nostr: { relays: ["wss://relay.example.com"] } };
const listed = (name: string, pk: string): IndexSolver => ({ name, discovery_pubkey: pk, transports: RELAYS });
const tRoutes = {
  ...routes,
  [REG_T]: {
    body: JSON.stringify({
      version: 0,
      network: "bitcoin",
      generated_at: GENERATED_AT,
      commit: "c".repeat(40),
      markets: [{ ...idxMarket("carol", 25), discovery_pubkey: CAROL.pk, transports: RELAYS }],
      solvers: [listed("carol", CAROL.pk), listed("pat", PAT.pk)],
    }),
  },
};
const liveCard = (name: string, fee: number, pk = CAROL.pk) =>
  ({ version: 0, name, discovery_pubkey: pk, transports: RELAYS, markets: [makeMarket({ fee_bps: fee })] });
const delivered = (card: unknown, pubkey = CAROL.pk, createdAt = NOW): TransportCard => ({ pubkey, createdAt, card });

function stub(cards: TransportCard[]) {
  const calls: Array<{ solvers: readonly IndexSolver[]; network: string }> = [];
  const fetcher: TransportCardFetcher = {
    fetch: async (solvers, network) => {
      calls.push({ solvers, network });
      return cards;
    },
  };
  return { fetcher, calls };
}

const discoverT = (transportCards?: TransportCardFetcher) =>
  discover({ registries: [REG_T], fetchImpl: mockFetch(tRoutes), now: () => NOW, transportCards });
const marketsOf = (res: Awaited<ReturnType<typeof discover>>) =>
  res.markets.map((m) => [m.solver, m.fee_bps, m.source, m.sourceType]);

test("transport cards: a passing card replaces its listing's markets, projected, under the listing's source", async () => {
  const { fetcher, calls } = stub([
    delivered(signed(liveCard("carol", 5))),
    delivered(signed(liveCard("pat", 7, PAT.pk), PAT.sk), PAT.pk, NOW - MAX_CARD_AGE_SECONDS),
  ]);
  const res = await discoverT(fetcher);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(calls, [{ solvers: [listed("carol", CAROL.pk), listed("pat", PAT.pk)], network: "bitcoin" }]);
  assert.deepEqual(marketsOf(res), [["carol", 5, REG_T, "registry"], ["pat", 7, REG_T, "registry"]]);
  assert.equal(res.markets[0].base_asset.id, "btc");
  assert.equal(res.markets[0].base_asset.caip19_id, BTC.id);
  assert.equal(res.sources[0].marketCount, 2);
});

test("transport cards: an entry with a non-numeric createdAt cannot shadow the solver's real card", async () => {
  const { fetcher } = stub([delivered(signed(liveCard("carol", 9)), CAROL.pk, "soon" as never), delivered(signed(liveCard("carol", 5)))]);
  const res = await discoverT(fetcher);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(marketsOf(res), [["carol", 5, REG_T, "registry"]]);
});

test("transport cards: a live clock is read once per discover(), for the index and the cards alike", async () => {
  let reads = 0;
  await discover({ registries: [REG_T], fetchImpl: mockFetch(tRoutes), now: () => (reads++, NOW), transportCards: stub([]).fetcher });
  assert.equal(reads, 1);
});

const STALE_NOW = GENERATED_AT + 8 * 86_400;
const discoverStale = (transportCards?: TransportCardFetcher) =>
  discover({ registries: [REG_T], localCards: [{ card: daveCard() }], fetchImpl: mockFetch(tRoutes), now: () => STALE_NOW, transportCards });

test("stale index: past four max-ages it vouches for no one, so a delisted solver's live card stops counting", async () => {
  const LONG_STALE = GENERATED_AT + 4 * 7 * 86_400 + 1;
  const { fetcher, calls } = stub([delivered(signed(liveCard("pat", 7, PAT.pk), PAT.sk), PAT.pk, LONG_STALE)]);
  const res = await discover({ registries: [REG_T], fetchImpl: mockFetch(tRoutes), now: () => LONG_STALE, transportCards: fetcher });
  assert.deepEqual(marketsOf(res), []);
  assert.equal(calls.length, 0);
  assert.match(res.warnings.join("\n"), /too stale to vouch/);
  assert.match(res.warnings.join("\n"), /1 market\(s\) held out/);
  assert.doesNotMatch(res.warnings.join("\n"), /still count/);
});

test("stale index: its own markets are held out, while local pins stand", async () => {
  const res = await discoverStale();
  assert.deepEqual(marketsOf(res), [["dave", 10, "local:dave", "local"]]);
  assert.equal(res.sources[0].ok, true);
  assert.match(res.warnings.join("\n"), /index is stale/);
  assert.match(res.warnings.join("\n"), /held out while the index is stale/);
});

test("stale index: solvers it lists still count through their fresh transport cards", async () => {
  const res = await discoverStale(
    stub([
      delivered(signed(liveCard("pat", 7, PAT.pk), PAT.sk), PAT.pk, STALE_NOW),
      delivered(signed(liveCard("carol", 5)), CAROL.pk, STALE_NOW),
    ]).fetcher,
  );
  assert.deepEqual(marketsOf(res), [
    ["carol", 5, REG_T, "registry"],
    ["pat", 7, REG_T, "registry"],
    ["dave", 10, "local:dave", "local"],
  ].sort((a, b) => Number(a[1]) - Number(b[1])));
  assert.doesNotMatch(res.warnings.join("\n"), /held out while/);
});

test("transport cards: without a fetcher, or with nothing delivered, the index stands and a pointer lists nothing", async () => {
  const res = await discoverT();
  assert.deepEqual(marketsOf(res), [["carol", 25, REG_T, "registry"]]);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(await discoverT(stub([]).fetcher), res);
});

const REJECTED: Array<[string, TransportCard, RegExp]> = [
  ["a name mismatch", delivered(signed(liveCard("mallory", 5))), /does not match the listing/],
  ["a card naming another key", delivered(signed(liveCard("carol", 5, PAT.pk), PAT.sk)), /does not match the listing/],
  ["a bad sig", delivered({ ...signed(liveCard("carol", 5)), markets: [makeMarket({ fee_bps: 1 })] }), /sig does not verify/],
  ["an unsigned card, before its markets are read", delivered({ ...liveCard("carol", 5), markets: [makeMarket({ fee_bps: 20_000 })] }), /sig does not verify/],
  ["a stale card", delivered(signed(liveCard("carol", 5)), CAROL.pk, NOW - MAX_CARD_AGE_SECONDS - 1), /stale/],
  ["a card dated too far ahead", delivered(signed(liveCard("carol", 5)), CAROL.pk, NOW + MAX_CARD_AGE_SECONDS + 1), /in the future/],
  ["an invalid card", delivered(signed({ ...liveCard("carol", 5), markets: [makeMarket({ fee_bps: 20_000 })] })), /fee_bps/],
  [
    "another network's ids",
    delivered(signed({ ...liveCard("carol", 5), markets: [makeMarket({ base_asset: { ...BTC, id: "arkade:mutinynet/slip44:1" } })] })),
    /names network "mutinynet"/,
  ],
  ["a pointer", delivered(signed({ version: 0, name: "carol", discovery_pubkey: CAROL.pk, transports: RELAYS })), /pointer/],
];

for (const [what, card, reason] of REJECTED) {
  test(`transport cards: ${what} is a warning on the listing, which keeps its own markets`, async () => {
    const res = await discoverT(stub([card]).fetcher);
    assert.deepEqual(marketsOf(res), [["carol", 25, REG_T, "registry"]]);
    assert.equal(res.warnings.length, 1, res.warnings.join("\n"));
    assert.ok(res.warnings[0].startsWith(`${REG_T}: transport card for carol`), res.warnings[0]);
    assert.match(res.warnings[0]!, reason);
  });
}

test("transport cards: a market with no v0 asset id is held out with a warning, as the reducer holds it out", async () => {
  const usdc = { id: `eip155:1/erc20:0x${"b".repeat(40)}`, name: "USD Coin", ticker: "USDC", decimals: 6 };
  const card = { ...liveCard("carol", 5), version: 1, markets: [makeMarket({ fee_bps: 5 }), makeMarket({ fee_bps: 6, quote_asset: usdc })] };
  const res = await discoverT(stub([delivered(signed(card))]).fetcher);
  assert.deepEqual(marketsOf(res), [["carol", 5, REG_T, "registry"]]);
  assert.match(res.warnings.join("\n"), /transport card for carol: held out, no v0 asset id: carol: arkade:bitcoin\/slip44:0 -> eip155:1\//);
});

test("transport cards: a card from a key no followed source lists is ignored", async () => {
  const res = await discoverT(stub([delivered(signed(liveCard("eve", 1, EVE.pk), EVE.sk), EVE.pk)]).fetcher);
  assert.deepEqual(marketsOf(res), [["carol", 25, REG_T, "registry"]]);
  assert.deepEqual(res.warnings, []);
});

test("transport cards: a fetcher that throws is one warning, on the source that lists solvers, and changes nothing else", async () => {
  const res = await discoverT({ fetch: async () => { throw new Error("relays down"); } });
  assert.deepEqual(marketsOf(res), [["carol", 25, REG_T, "registry"]]);
  assert.deepEqual(res.warnings, [`${REG_T}: transport cards: relays down`]);
  assert.deepEqual(res.sources[0].warnings, ["transport cards: relays down"]);
});

test("transport cards: a pinned card with a nostr transport is an identity, and keeps its local source", async () => {
  const { fetcher, calls } = stub([delivered(signed(liveCard("dave", 12, EVE.pk), EVE.sk), EVE.pk)]);
  const res = await discover({
    registries: [],
    localCards: [{ card: liveCard("dave", 40, EVE.pk) }, { card: daveCard(), label: "keyless" }],
    fetchImpl: mockFetch(routes),
    now: () => NOW,
    transportCards: fetcher,
  });
  assert.deepEqual(calls[0].solvers, [listed("dave", EVE.pk)]);
  assert.deepEqual(marketsOf(res), [["dave", 10, "keyless", "local"], ["dave", 12, "local:dave", "local"]]);
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
