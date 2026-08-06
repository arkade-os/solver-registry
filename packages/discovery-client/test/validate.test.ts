import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCard, validateIndex } from "../src/validate.ts";
import { makeMarket, makeOneSidedMarket } from "./helpers.ts";

function validCard(): any {
  return { version: 0, name: "alice", markets: [makeMarket()] };
}

function validIndex(): any {
  const card = validCard();
  return {
    version: 0,
    network: "bitcoin",
    generated_at: 1_700_000_000,
    commit: "a".repeat(40),
    markets: [{ ...card.markets[0], solver: "alice" }],
  };
}

test("validateCard: accepts a well-formed card", () => {
  const r = validateCard(validCard());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.value);
});

test("validateCard: accepts an optionally signed card", () => {
  const c = validCard();
  c.discovery_pubkey = "d".repeat(64);
  c.sig = "0".repeat(128);
  assert.equal(validateCard(c).ok, true);
});

test("validateCard: accepts a corridor card carrying the RFQ rendezvous", () => {
  const c = validCard();
  c.markets[0] = {
    ...c.markets[0],
    pair: "BTC/lightning:BTC",
    quote_asset: { ...c.markets[0].base_asset },
    quote_corridor: "lightning",
  };
  delete c.markets[0].price_feed;
  delete c.markets[0].price_feed_schema;
  delete c.markets[0].price_decimals;
  // Card-level format checks only — signature verification is the reducer's job.
  c.discovery_pubkey = "d".repeat(64);
  c.sig = "0".repeat(128);
  c.transports = { nostr: { relays: ["wss://relay.example.com"] } };
  const r = validateCard(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateCard: tolerates unknown nostr-transport keys alongside relays", () => {
  // The nostr config object stays open to future settings (e.g. per-relay
  // read/write markers) without a schema break.
  const c = validCard();
  c.markets[0] = {
    ...c.markets[0],
    pair: "BTC/lightning:BTC",
    quote_asset: { ...c.markets[0].base_asset },
    quote_corridor: "lightning",
  };
  delete c.markets[0].price_feed;
  delete c.markets[0].price_feed_schema;
  delete c.markets[0].price_decimals;
  c.discovery_pubkey = "d".repeat(64);
  c.sig = "0".repeat(128);
  c.transports = { nostr: { relays: ["wss://relay.example.com"], read: true, write: false } };
  const r = validateCard(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateCard: explicit base_corridor 'arkade' is equivalent to omitting it", () => {
  // marketCorridor defaults an absent side to arkade; writing it out must
  // change nothing — same spot semantics, same pair label, no rendezvous
  // requirements.
  const c = validCard();
  c.markets[0] = { ...c.markets[0], base_corridor: "arkade", quote_corridor: "arkade" };
  const r = validateCard(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateCard: accepts a cross-asset corridor market carrying a feed", () => {
  // arkade:BTC base, lightning:USDT quote — different assets, so the feed
  // fields stay required exactly as on a spot market.
  const c = validCard();
  c.markets[0] = {
    ...c.markets[0],
    pair: "BTC/lightning:USDT",
    quote_corridor: "lightning",
  };
  c.discovery_pubkey = "d".repeat(64);
  c.transports = { nostr: { relays: ["wss://relay.example.com"] } };
  const r = validateCard(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateCard: accepts a market with both sides off-rail (no canonical leg order)", () => {
  // lightning:BTC / onchain:BTC — a submarine-swap market with no Arkade
  // side. The arkade-must-be-base rule fires only when exactly one side is
  // arkade; the rendezvous requirements still apply.
  const c = validCard();
  c.markets[0] = {
    ...c.markets[0],
    pair: "lightning:BTC/onchain:BTC",
    quote_asset: { ...c.markets[0].base_asset },
    base_corridor: "lightning",
    quote_corridor: "onchain",
  };
  delete c.markets[0].price_feed;
  delete c.markets[0].price_feed_schema;
  delete c.markets[0].price_decimals;
  c.discovery_pubkey = "d".repeat(64);
  c.sig = "0".repeat(128);
  c.transports = { nostr: { relays: ["wss://relay.example.com"] } };
  const r = validateCard(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateCard: accepts a one-sided market (the other side disabled with 0/0)", () => {
  for (const solves of ["base", "quote"] as const) {
    const r = validateCard({ version: 0, name: "alice", markets: [makeOneSidedMarket(solves)] });
    assert.equal(r.ok, true, `${solves}: ${JSON.stringify(r.errors)}`);
  }
});

const CARD_REJECTIONS: Array<{ name: string; mutate: (c: any) => void; expect: RegExp }> = [
  { name: "bad version", mutate: (c) => (c.version = 1), expect: /version/ },
  { name: "bad name pattern", mutate: (c) => (c.name = "Alice"), expect: /name/ },
  { name: "additional property", mutate: (c) => (c.extra = true), expect: /not an allowed property/ },
  {
    name: "asset additional property",
    mutate: (c) => (c.markets[0].base_asset.extra = true),
    expect: /base_asset\/extra is not an allowed property/,
  },
  {
    name: "base min > max",
    mutate: (c) => (c.markets[0].min_base_amount = "9000000"),
    expect: /min_base_amount \(9000000\) > max_base_amount/,
  },
  {
    name: "quote min > max",
    mutate: (c) => (c.markets[0].min_quote_amount = "2000000000000000"),
    expect: /min_quote_amount \(2000000000000000\) > max_quote_amount/,
  },
  {
    name: "missing limit field",
    mutate: (c) => delete c.markets[0].max_quote_amount,
    expect: /max_quote_amount must be a decimal string/,
  },
  {
    name: "zero min on an enabled side",
    mutate: (c) => (c.markets[0].min_quote_amount = "0"),
    expect: /min_quote_amount must be >= 1 when max_quote_amount > 0/,
  },
  {
    name: "number amount (wrong encoding)",
    mutate: (c) => (c.markets[0].max_quote_amount = 5000000),
    expect: /max_quote_amount must be a decimal string/,
  },
  {
    name: "non-canonical amount (leading zeros)",
    mutate: (c) => (c.markets[0].min_base_amount = "0100"),
    expect: /min_base_amount must be a decimal string/,
  },
  {
    name: "both sides disabled",
    mutate: (c) => {
      c.markets[0].min_base_amount = "0";
      c.markets[0].max_base_amount = "0";
      c.markets[0].min_quote_amount = "0";
      c.markets[0].max_quote_amount = "0";
    },
    expect: /at least one side/,
  },
  {
    name: "pair/ticker mismatch",
    mutate: (c) => (c.markets[0].pair = "BTC/USD"),
    expect: /does not match the sides' labels/,
  },
  {
    name: "identical legs",
    mutate: (c) => {
      c.markets[0].pair = "BTC/BTC";
      c.markets[0].quote_asset = { ...c.markets[0].base_asset };
      delete c.markets[0].price_feed;
      delete c.markets[0].price_feed_schema;
      delete c.markets[0].price_decimals;
    },
    expect: /market legs must differ/,
  },
  {
    name: "feed on a same-asset corridor market",
    mutate: (c) => {
      c.markets[0].pair = "BTC/lightning:BTC";
      c.markets[0].quote_asset = { ...c.markets[0].base_asset };
      c.markets[0].quote_corridor = "lightning";
    },
    expect: /must be absent on a same-asset market/,
  },
  {
    name: "cross-asset market without a feed",
    mutate: (c) => {
      delete c.markets[0].price_feed;
      delete c.markets[0].price_feed_schema;
      delete c.markets[0].price_decimals;
    },
    expect: /is required when the sides carry different assets/,
  },
  {
    name: "arkade side not base",
    mutate: (c) => {
      c.markets[0].pair = "lightning:BTC/USDT";
      c.markets[0].base_corridor = "lightning";
    },
    expect: /must be the base side/,
  },
  {
    name: "unknown corridor",
    mutate: (c) => (c.markets[0].quote_corridor = "liquid"),
    expect: /quote_corridor must be one of arkade, lightning, onchain/,
  },
  {
    name: "corridor market without the RFQ rendezvous",
    mutate: (c) => {
      c.markets[0].pair = "BTC/lightning:BTC";
      c.markets[0].quote_asset = { ...c.markets[0].base_asset };
      c.markets[0].quote_corridor = "lightning";
      delete c.markets[0].price_feed;
      delete c.markets[0].price_feed_schema;
      delete c.markets[0].price_decimals;
    },
    expect: /transports is required when any market has a non-arkade corridor/,
  },
  {
    name: "non-wss relay",
    mutate: (c) => (c.transports = { nostr: { relays: ["https://relay.example.com"] } }),
    expect: /must be a wss:\/\/ URL/,
  },
  {
    name: "empty relays list",
    mutate: (c) => (c.transports = { nostr: { relays: [] } }),
    expect: /transports\/nostr\/relays/,
  },
  {
    name: "missing relays key",
    mutate: (c) => (c.transports = { nostr: { read: true } }),
    expect: /transports\/nostr\/relays/,
  },
  {
    name: "empty transports map",
    mutate: (c) => (c.transports = {}),
    expect: /transports/,
  },
  {
    name: "unsupported relay protocol",
    mutate: (c) => (c.transports = { custom: { relays: ["wss://relay.example.com"] } }),
    expect: /transports/,
  },
  {
    name: "bad relay protocol",
    mutate: (c) => (c.transports = { "Nostr!": { relays: ["wss://relay.example.com"] } }),
    expect: /transports\/Nostr!/,
  },
  { name: "bad asset id", mutate: (c) => (c.markets[0].base_asset.id = "xyz"), expect: /id/ },
  {
    name: "bad price feed schema",
    mutate: (c) => (c.markets[0].price_feed_schema.price_path = "bitcoin/usd"),
    expect: /JSON Pointer/,
  },
  {
    // https only, like the schemas — a laxer client check would admit local
    // cards the reducer rejects.
    name: "plain-http price feed",
    mutate: (c) => (c.markets[0].price_feed = "http://feed.example.com/btcusdt"),
    expect: /must be an https:\/\/ URL/,
  },
  { name: "fee out of range", mutate: (c) => (c.markets[0].fee_bps = 20_000), expect: /fee_bps/ },
  { name: "sig without pubkey", mutate: (c) => (c.sig = "0".repeat(128)), expect: /discovery_pubkey/ },
  { name: "empty markets", mutate: (c) => (c.markets = []), expect: /markets/ },
  { name: "missing required", mutate: (c) => delete c.markets[0].fee_bps, expect: /fee_bps/ },
];

for (const { name, mutate, expect } of CARD_REJECTIONS) {
  test(`validateCard rejects: ${name}`, () => {
    const c = validCard();
    mutate(c);
    const r = validateCard(c);
    assert.equal(r.ok, false, `${name} should fail`);
    assert.match(r.errors.join("\n"), expect);
  });
}

test("validateIndex: accepts a well-formed index", () => {
  const r = validateIndex(validIndex(), "bitcoin");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateIndex: tolerates unknown forward-compatible fields", () => {
  const idx = validIndex();
  idx.future_field = 123;
  idx.markets[0].future_market_field = "x";
  assert.equal(validateIndex(idx, "bitcoin").ok, true);
});

test("validateIndex: rejects unknown version", () => {
  const idx = validIndex();
  idx.version = 1;
  assert.match(validateIndex(idx).errors.join("\n"), /version/);
});

test("validateIndex: rejects a network mismatch", () => {
  const r = validateIndex(validIndex(), "signet");
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /expected "signet"/);
});

test("validateIndex: rejects a bad commit and a market missing solver", () => {
  const idx = validIndex();
  idx.commit = "nothex";
  delete idx.markets[0].solver;
  const r = validateIndex(idx, "bitcoin");
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /commit/);
  assert.match(r.errors.join("\n"), /solver/);
});
