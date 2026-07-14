import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCard, validateIndex } from "../src/validate.ts";
import { makeMarket } from "./helpers.ts";

function validCard(): any {
  return { version: 0, name: "alice", markets: [makeMarket()] };
}

function validIndex(): any {
  const card = validCard();
  return {
    version: 0,
    network: "mainnet",
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

const CARD_REJECTIONS: Array<{ name: string; mutate: (c: any) => void; expect: RegExp }> = [
  { name: "bad version", mutate: (c) => (c.version = 1), expect: /version/ },
  { name: "bad name pattern", mutate: (c) => (c.name = "Alice"), expect: /name/ },
  { name: "additional property", mutate: (c) => (c.extra = true), expect: /not an allowed property/ },
  {
    name: "asset additional property",
    mutate: (c) => (c.markets[0].base_asset.extra = true),
    expect: /base_asset\/extra is not an allowed property/,
  },
  { name: "min > max", mutate: (c) => (c.markets[0].min_base_amount = 9_000_000), expect: /min_base_amount/ },
  {
    name: "pair/ticker mismatch",
    mutate: (c) => (c.markets[0].pair = "BTC/USD"),
    expect: /does not match asset tickers/,
  },
  { name: "bad asset id", mutate: (c) => (c.markets[0].base_asset.id = "xyz"), expect: /id/ },
  { name: "non-https feed", mutate: (c) => (c.markets[0].price_feed = "http://x"), expect: /https/ },
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
  const r = validateIndex(validIndex(), "mainnet");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateIndex: tolerates unknown forward-compatible fields", () => {
  const idx = validIndex();
  idx.future_field = 123;
  idx.markets[0].future_market_field = "x";
  assert.equal(validateIndex(idx, "mainnet").ok, true);
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
  const r = validateIndex(idx, "mainnet");
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /commit/);
  assert.match(r.errors.join("\n"), /solver/);
});
