import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { reduceAll, reduceNetwork, NETWORKS, findUnknownNetworkDirs } from "../scripts/reduce.ts";
import { AMOUNT_PATTERN, ASSET_KEYS, MAX_ASSET_DECIMALS } from "../packages/discovery-client/src/types.ts";
import { validateIndex } from "../packages/discovery-client/src/validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXED_META = { generatedAt: 1700000000, commit: "a".repeat(40) };

function fixture(...parts: string[]) {
  return join(here, "fixtures", ...parts);
}

function goldenOf(network: string) {
  return join(here, "golden", `${network}.json`);
}

test("golden: valid fixtures reduce to the checked-in golden index per network", () => {
  const results = reduceAll(fixture("valid", "solvers"), FIXED_META);
  for (const result of results) {
    assert.equal(result.ok, true, `${result.network} should be ok: ${JSON.stringify(result.errors)}`);
    const expected = JSON.parse(readFileSync(goldenOf(result.network), "utf8"));
    assert.deepEqual(result.index, expected, `${result.network} index mismatches golden`);
  }
});

test("determinism: same inputs produce byte-identical output across runs", () => {
  const first = reduceAll(fixture("valid", "solvers"), FIXED_META);
  const second = reduceAll(fixture("valid", "solvers"), FIXED_META);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("sort order: within a pair, ascending fee_bps, ties broken by solver name", () => {
  const result = reduceNetwork(fixture("valid", "solvers"), "bitcoin", FIXED_META);
  assert.equal(result.ok, true);
  const solvers = result.index!.markets.map((m) => m.solver);
  assert.deepEqual(solvers, ["alice", "carol", "bob"]);
});

// The signed-solver fixture is signed with the BIP340 test-vector #1 secret key
// (b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef); re-sign
// with scripts/canonical.ts signCard() whenever the fixture's content changes.
test("signed card: valid signature verifies and discovery_pubkey propagates to the index", () => {
  const result = reduceNetwork(fixture("valid", "solvers"), "signet", FIXED_META);
  assert.equal(result.ok, true);
  const entry = result.index!.markets.find((m) => m.solver === "signed-solver");
  assert.ok(entry);
  assert.equal(entry!.discovery_pubkey, "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659");
});

test("mixed: a broken network fails independently without blocking sibling networks", () => {
  const results = reduceAll(fixture("mixed", "solvers"), FIXED_META);
  const byNetwork = Object.fromEntries(results.map((r) => [r.network, r]));
  assert.equal(byNetwork.bitcoin.ok, true);
  assert.equal(byNetwork.signet.ok, false);
  assert.equal(byNetwork.mutinynet.ok, true);
});

const REJECTION_CASES: Array<{ case: string; expect: string }> = [
  { case: "bad-version", expect: "must be equal to constant" },
  { case: "name-mismatch", expect: "does not match filename" },
  { case: "name-pattern", expect: "must match pattern" },
  { case: "duplicate-name", expect: "duplicate name" },
  { case: "bad-pair", expect: "must match pattern" },
  { case: "bad-asset-id", expect: "must match pattern" },
  { case: "pair-ticker-mismatch", expect: "does not match asset tickers" },
  { case: "bad-price-feed", expect: "must match pattern" },
  { case: "bad-price-decimals", expect: "must be <=" },
  { case: "bad-fee-bps", expect: "must be <=" },
  { case: "min-gt-max", expect: "min_base_amount" },
  { case: "quote-min-gt-max", expect: "min_quote_amount" },
  { case: "unpaired-limits", expect: "must have required property" },
  { case: "no-limits", expect: "must enable size limits for at least one side" },
  { case: "non-positive-amount", expect: "min_base_amount must be >= 1 when max_base_amount > 0" },
  { case: "bad-amount-type", expect: "must be string" },
  { case: "sig-without-pubkey", expect: "must have property" },
  { case: "tampered-sig", expect: "sig does not verify" },
  { case: "additional-properties", expect: "must NOT have additional properties" },
  { case: "missing-required", expect: "must have required property" },
];

for (const { case: caseName, expect } of REJECTION_CASES) {
  test(`rejects: ${caseName}`, () => {
    const result = reduceNetwork(fixture("invalid", caseName), "bitcoin", FIXED_META);
    assert.equal(result.ok, false, `${caseName} should fail validation`);
    const allMessages = result.errors.flatMap((e) => e.messages).join("\n");
    assert.match(allMessages, new RegExp(expect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("a card placed outside a known network directory is flagged", () => {
  const unknown = findUnknownNetworkDirs(fixture("unknown-network"));
  assert.deepEqual(unknown, ["testnet"]);
});

test("NETWORKS constant covers bitcoin, signet, mutinynet", () => {
  assert.deepEqual([...NETWORKS], ["bitcoin", "signet", "mutinynet"]);
});

// The amount encoding is declared once per artifact (client AMOUNT_PATTERN,
// each schema's definitions.amount, and its positive subset enabledAmount that
// backs the at-least-one-side anyOf); this pins them all to one source.
test("the schemas' amount definitions match the client's AMOUNT_PATTERN", () => {
  // "^(0|[1-9][0-9]{0,29})$" minus the zero alternative.
  const enabled = AMOUNT_PATTERN.source.replace("(0|", "").replace(")$", "$");
  for (const name of ["card.schema.json", "index.schema.json"]) {
    const schema = JSON.parse(readFileSync(join(here, "..", "schema", name), "utf8"));
    assert.equal(schema.definitions.amount.pattern, AMOUNT_PATTERN.source, name);
    assert.equal(schema.definitions.enabledAmount.pattern, enabled, name);
  }
});

// The asset shape is likewise declared once per artifact. Without this pin a
// skew in index.schema.json alone escapes the whole suite: that schema is
// compiled against no document here — only third-party consumers run it.
test("the schemas' asset definitions match the client's ASSET_KEYS and decimals bound", () => {
  for (const name of ["card.schema.json", "index.schema.json"]) {
    const asset = JSON.parse(readFileSync(join(here, "..", "schema", name), "utf8")).definitions.asset;
    assert.deepEqual(asset.required, [...ASSET_KEYS], name);
    assert.deepEqual(Object.keys(asset.properties).sort(), [...ASSET_KEYS].sort(), name);
    assert.equal(asset.properties.decimals.minimum, 0, name);
    assert.equal(asset.properties.decimals.maximum, MAX_ASSET_DECIMALS, name);
  }
});

// Nothing else runs an index through the client's hand-rolled validator, so a
// reducer/validator skew would only ever surface in a browser at runtime.
test("golden indexes validate under the client's validateIndex", () => {
  for (const network of NETWORKS) {
    const idx = JSON.parse(readFileSync(goldenOf(network), "utf8"));
    const r = validateIndex(idx, network);
    assert.equal(r.ok, true, `${network}: ${r.errors.join("; ")}`);
  }
});
