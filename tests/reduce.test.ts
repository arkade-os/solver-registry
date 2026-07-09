import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { reduceAll, reduceNetwork, NETWORKS, findUnknownNetworkDirs } from "../scripts/reduce.ts";

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
  const result = reduceNetwork(fixture("valid", "solvers"), "mainnet", FIXED_META);
  assert.equal(result.ok, true);
  const solvers = result.index!.markets.map((m) => m.solver);
  assert.deepEqual(solvers, ["alice", "carol", "bob"]);
});

test("signed card: valid signature verifies and discovery_pubkey propagates to the index", () => {
  const result = reduceNetwork(fixture("valid", "solvers"), "signet", FIXED_META);
  assert.equal(result.ok, true);
  const entry = result.index!.markets.find((m) => m.solver === "signed-solver");
  assert.ok(entry);
  assert.equal(entry!.discovery_pubkey, "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
});

test("mixed: a broken network fails independently without blocking sibling networks", () => {
  const results = reduceAll(fixture("mixed", "solvers"), FIXED_META);
  const byNetwork = Object.fromEntries(results.map((r) => [r.network, r]));
  assert.equal(byNetwork.mainnet.ok, true);
  assert.equal(byNetwork.signet.ok, false);
  assert.equal(byNetwork.mutinynet.ok, true);
});

const REJECTION_CASES: Array<{ case: string; expect: string }> = [
  { case: "bad-version", expect: "must be equal to constant" },
  { case: "name-mismatch", expect: "does not match filename" },
  { case: "name-pattern", expect: "must match pattern" },
  { case: "duplicate-name", expect: "duplicate name" },
  { case: "bad-pair", expect: "must match pattern" },
  { case: "bad-price-feed", expect: "must match pattern" },
  { case: "bad-price-decimals", expect: "must be <=" },
  { case: "bad-fee-bps", expect: "must be <=" },
  { case: "min-gt-max", expect: "min_base_amount" },
  { case: "non-positive-amount", expect: "must be >=" },
  { case: "sig-without-pubkey", expect: "must have property" },
  { case: "tampered-sig", expect: "sig does not verify" },
  { case: "additional-properties", expect: "must NOT have additional properties" },
  { case: "missing-required", expect: "must have required property" },
];

for (const { case: caseName, expect } of REJECTION_CASES) {
  test(`rejects: ${caseName}`, () => {
    const result = reduceNetwork(fixture("invalid", caseName), "mainnet", FIXED_META);
    assert.equal(result.ok, false, `${caseName} should fail validation`);
    const allMessages = result.errors.flatMap((e) => e.messages).join("\n");
    assert.match(allMessages, new RegExp(expect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("a card placed outside a known network directory is flagged", () => {
  const unknown = findUnknownNetworkDirs(fixture("unknown-network"));
  assert.deepEqual(unknown, ["testnet"]);
});

test("NETWORKS constant covers mainnet, signet, mutinynet", () => {
  assert.deepEqual([...NETWORKS], ["mainnet", "signet", "mutinynet"]);
});
