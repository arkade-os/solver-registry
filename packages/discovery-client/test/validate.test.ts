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
  c.relays = ["wss://relay.example.com"];
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
    expect: /relays is required when any market has a non-arkade corridor/,
  },
  {
    name: "non-wss relay",
    mutate: (c) => (c.relays = ["https://relay.example.com"]),
    expect: /must be a wss:\/\/ URL/,
  },
  {
    name: "empty relays",
    mutate: (c) => (c.relays = []),
    expect: /relays/,
  },
  { name: "bad asset id", mutate: (c) => (c.markets[0].base_asset.id = "xyz"), expect: /id/ },
  {
    name: "bad price feed schema",
    mutate: (c) => (c.markets[0].price_feed_schema.price_path = "bitcoin/usd"),
    expect: /JSON Pointer/,
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
