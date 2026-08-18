import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { reduceAll, reduceNetwork, NETWORKS, findUnknownNetworkDirs } from "../scripts/reduce.ts";
import { AMOUNT_PATTERN, ASSET_KEYS, CORRIDORS, MAX_ASSET_DECIMALS, MAX_RELAYS } from "../packages/discovery-client/src/types.ts";
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
  // corridor-solver's BTC/lightning:BTC market sorts into its own leg-pair
  // group, after the BTC/USDT group (alice/carol/bob) it doesn't share.
  assert.deepEqual(solvers, ["alice", "carol", "bob", "corridor-solver"]);
});

// The signed-solver fixture is signed with the BIP340 test-vector #1 secret key
// (b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef); re-sign
// with scripts/canonical.ts signCard() whenever the fixture's content changes.
test("signed card: valid signature verifies; discovery_pubkey and transports propagate to the index", () => {
  const result = reduceNetwork(fixture("valid", "solvers"), "signet", FIXED_META);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const entry = result.index!.markets.find((m) => m.solver === "signed-solver");
  assert.ok(entry);
  assert.equal(entry!.discovery_pubkey, "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659");
  assert.deepEqual(entry!.transports, { nostr: { relays: ["wss://relay.example.com", "wss://relay2.example.com"] } });
});

// corridor-solver is signed with the same BIP340 test-vector #1 secret key as
// signed-solver above; re-sign with scripts/canonical.ts signCard() whenever
// the fixture's content changes.
test("a corridor card carrying no emulator_pubkey reduces cleanly", () => {
  const result = reduceNetwork(fixture("valid", "solvers"), "bitcoin", FIXED_META);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const entry = result.index!.markets.find((m) => m.solver === "corridor-solver");
  assert.ok(entry);
  assert.equal(entry!.discovery_pubkey, "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659");
  // The key is the network's, not the solver's: nothing named "emulator" survives
  // on an index entry, so a consumer cannot read a per-solver value here.
  assert.equal(Object.keys(entry!).some((k) => k.includes("emulator")), false);
});

test("corridor markets group by leg pair: lightning and onchain BTC/BTC stay distinct", () => {
  const result = reduceNetwork(fixture("valid", "solvers"), "signet", FIXED_META);
  assert.equal(result.ok, true);
  // The third entry is the rail-to-rail market (no arkade side): accepted,
  // and sorted under its own leg-pair key like any other.
  assert.deepEqual(
    result.index!.markets.map((m) => m.pair),
    ["BTC/lightning:BTC", "BTC/onchain:BTC", "lightning:BTC/onchain:BTC"],
  );
});

test("mixed: a broken network fails independently without blocking sibling networks", () => {
  const results = reduceAll(fixture("mixed", "solvers"), FIXED_META);
  const byNetwork = Object.fromEntries(results.map((r) => [r.network, r]));
  assert.equal(byNetwork.bitcoin.ok, true);
  assert.equal(byNetwork.signet.ok, false);
  assert.equal(byNetwork.mutinynet.ok, true);
  assert.equal(byNetwork.regtest.ok, true);
});

const REJECTION_CASES: Array<{ case: string; expect: string }> = [
  { case: "bad-version", expect: "must be equal to constant" },
  { case: "name-mismatch", expect: "does not match filename" },
  { case: "name-pattern", expect: "must match pattern" },
  { case: "duplicate-name", expect: "duplicate name" },
  { case: "bad-pair", expect: "must match pattern" },
  { case: "bad-asset-id", expect: "must match pattern" },
  { case: "pair-ticker-mismatch", expect: "does not match the sides' labels" },
  { case: "identical-legs", expect: "market legs must differ" },
  { case: "feed-on-same-asset", expect: "must be absent on a same-asset market" },
  { case: "missing-feed", expect: "is required when the sides carry different assets" },
  { case: "corridor-not-base", expect: "must be the base side" },
  { case: "bad-corridor", expect: "must be equal to one of the allowed values" },
  { case: "corridor-pair-label", expect: "does not match the sides' labels" },
  { case: "bad-relay", expect: "must match pattern" },
  // The fixture's key is well-formed 64-hex: emulator_pubkey is now refused for
  // existing at all, not for being malformed. The card schema is
  // additionalProperties:false, so this is a hard rejection, not a silent ignore.
  { case: "emulator-pubkey", expect: "must NOT have additional properties" },
  { case: "rfq-no-auth", expect: "discovery_pubkey is required when any market has a non-arkade corridor" },
  { case: "rfq-missing-relays", expect: "transports is required when any market has a non-arkade corridor" },
  // pubkey + transports present, sig absent: cardRfqErrors is satisfied, so this
  // isolates the reducer's registry-only sig requirement.
  { case: "rfq-sig-missing", expect: "sig is required when any market has a non-arkade corridor" },
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

test("NETWORKS constant covers bitcoin, signet, mutinynet, regtest", () => {
  assert.deepEqual([...NETWORKS], ["bitcoin", "signet", "mutinynet", "regtest"]);
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

// The corridor vocabulary is likewise declared once per artifact; a schema-only
// corridor (or a client-only one) would let cards merge that clients can't
// group, or reject cards CI accepted.
test("the schemas' corridor definitions match the client's CORRIDORS and relay bound", () => {
  // The pair pattern embeds the non-arkade corridors as an alternation; a
  // corridor added to CORRIDORS without touching the schemas would slip
  // past the enum check below but not this one.
  const alternation = `(${CORRIDORS.filter((c) => c !== "arkade").join("|")}):`;
  for (const name of ["card.schema.json", "index.schema.json"]) {
    const schema = JSON.parse(readFileSync(join(here, "..", "schema", name), "utf8"));
    assert.deepEqual(schema.definitions.corridor.enum, [...CORRIDORS], name);
    assert.ok(
      JSON.stringify(schema).includes(alternation),
      `${name}: pair pattern must embed ${alternation}`,
    );
  }
  const card = JSON.parse(readFileSync(join(here, "..", "schema", "card.schema.json"), "utf8"));
  assert.equal(card.definitions.transports.properties.nostr.properties.relays.maxItems, MAX_RELAYS);
  const index = JSON.parse(readFileSync(join(here, "..", "schema", "index.schema.json"), "utf8"));
  assert.equal(
    index.properties.markets.items.properties.transports.properties.nostr.properties.relays.maxItems,
    MAX_RELAYS,
  );
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

// The asset identity rule is declared in three places -- both schemas and the
// client's hand-rolled validator -- and an id that clears one copy but not
// another is a silent routing miss, not an error. The two literals below are
// duplicated from the shared vector rather than imported, because this repo's
// client and tests are dependency-free by design; a 68-character constant that
// is frozen by definition is safe to duplicate, logic is not.
//
// Source: @arkade-os/sdk ASSET_ID_VECTORS, entry "endianness discriminator
// (gidx 258 = 0x0102)" -- packages/ts-sdk/src/extension/asset/assetIdVectors.json.
// Keep in sync; see ts-sdk plans/asset-id-shared-vectors.md.
const ASSET_ID_VECTOR = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f200201";
const ASSET_ID_VECTOR_UPPERCASE = ASSET_ID_VECTOR.toUpperCase();

test("all three copies of the asset identity rule accept the shared vector and reject uppercase", () => {
  const drift = (where: string) =>
    `asset id encoding drifted from @arkade-os/sdk ASSET_ID_VECTORS (${where})`;

  // Both schemas, read as the regex they declare.
  for (const name of ["card.schema.json", "index.schema.json"]) {
    const schema = JSON.parse(readFileSync(join(here, "..", "schema", name), "utf8"));
    const pattern = new RegExp(schema.definitions.asset.properties.id.pattern);
    assert.ok(pattern.test(ASSET_ID_VECTOR), drift(name));
    assert.ok(!pattern.test(ASSET_ID_VECTOR_UPPERCASE), drift(`${name}: uppercase`));
    assert.ok(pattern.test("btc"), drift(`${name}: btc sentinel`));
  }

  // ...and the client's own copy, exercised through the validator rather than
  // by re-reading the regex, so a drifted call site fails here too.
  const index = JSON.parse(readFileSync(goldenOf("bitcoin"), "utf8"));
  const withId = (id: string) => ({
    ...index,
    markets: index.markets.map((m: { quote_asset: object }, i: number) =>
      i === 0 ? { ...m, quote_asset: { ...m.quote_asset, id } } : m,
    ),
  });

  const accepted = validateIndex(withId(ASSET_ID_VECTOR), "bitcoin");
  assert.equal(accepted.ok, true, `${drift("validate.ts")}: ${JSON.stringify(accepted.errors)}`);

  const rejected = validateIndex(withId(ASSET_ID_VECTOR_UPPERCASE), "bitcoin");
  assert.equal(rejected.ok, false, drift("validate.ts: uppercase"));
  assert.ok(
    rejected.errors.some((e) => e.includes("quote_asset/id")),
    drift("validate.ts: uppercase must fail on the id, not incidentally"),
  );
});
