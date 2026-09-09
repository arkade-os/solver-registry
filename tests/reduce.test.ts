import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { reduceAll, reduceNetwork, NETWORKS, findUnknownNetworkDirs } from "../scripts/reduce.ts";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  AMOUNT_PATTERN,
  ASSET_KEYS,
  CORRIDORS,
  MAX_ASSET_DECIMALS,
  MAX_RELAYS,
  legacyMarketCorridor,
  marketPairKey,
} from "../packages/discovery-client/src/types.ts";
import { ASSET_ID_FORMS, validateIndex } from "../packages/discovery-client/src/validate.ts";

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
  // corridor-solver's arkade/bolt11 BTC market sorts into its own leg-pair
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

test("corridor markets group by leg pair: bolt11 and bitcoin(onchain) BTC/BTC stay distinct", () => {
  const result = reduceNetwork(fixture("valid", "solvers"), "signet", FIXED_META);
  assert.equal(result.ok, true);
  // The third entry is the rail-to-rail market (no arkade side): accepted,
  // and sorted under its own leg-pair key like any other. Corridor is now
  // bundled into the id, so the leg-pair key IS the base/quote id pair.
  assert.deepEqual(
    result.index!.markets.map((m) => marketPairKey(m)),
    [
      "arkade:signet/slip44:1/bitcoin:signet/slip44:1",
      "arkade:signet/slip44:1/bolt11:signet/slip44:1",
      "bolt11:signet/slip44:1/bitcoin:signet/slip44:1",
    ],
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
  // Ajv words `enum` differently from `const`, and `version` became an enum when
  // 1 was added. The fixture carries 2 — still an unknown version, which is what
  // this case is for.
  { case: "bad-version", expect: "must be equal to one of the allowed values" },
  // The version rule, from the reducer's side: an EVM rail is a post-v0
  // corridor, so the card must say version 1. Everything else about this
  // fixture is valid — it is signed-shaped, fed, and bounded — so a pass here
  // could only mean the rule is not running.
  { case: "evm-corridor-needs-v1", expect: "version must be 1" },
  { case: "name-mismatch", expect: "does not match filename" },
  { case: "name-pattern", expect: "must match pattern" },
  { case: "duplicate-name", expect: "duplicate name" },
  { case: "bad-asset-id", expect: "must match pattern" },
  { case: "identical-legs", expect: "market legs must differ" },
  { case: "feed-on-same-asset", expect: "must be absent on a same-asset market" },
  { case: "missing-feed", expect: "is required when the sides carry different assets" },
  { case: "corridor-not-base", expect: "must be the base side" },
  // The card lives under solvers/bitcoin/ but the quote side's id names
  // mutinynet — a redundancy the corridor-bundled id introduced that the
  // pre-bundling schema never had to check.
  { case: "network-mismatch", expect: 'names network "mutinynet" but this card lives under the "bitcoin" directory' },
  // "liquid" is not a recognised chain namespace, so this is now an ordinary
  // asset-id pattern rejection rather than a separate corridor-enum check —
  // the corridor is bundled into the id, so there's no longer a standalone
  // field for an "unknown corridor" to live in.
  { case: "bad-corridor", expect: "must match pattern" },
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
  // The id pattern is the same class of duplicate as `amount` above: each
  // schema keeps its own literal copy of the alternation the client builds
  // from ASSET_ID_FORMS. Unpinned, a form added to the client is admitted by
  // the client and refused by the schemas — and the schemas are what a
  // third-party consumer runs, so the skew shows up as "this registry accepts
  // a card my validator rejects", not as a red suite here.
  const assetIdPattern = `^(${ASSET_ID_FORMS.map((f) => f.pattern).join("|")})$`;
  for (const name of ["card.schema.json", "index.schema.json"]) {
    const asset = JSON.parse(readFileSync(join(here, "..", "schema", name), "utf8")).definitions.asset;
    assert.deepEqual(asset.required, [...ASSET_KEYS], name);
    assert.deepEqual(Object.keys(asset.properties).sort(), [...ASSET_KEYS].sort(), name);
    assert.equal(asset.properties.id.pattern, assetIdPattern, name);
    assert.equal(asset.properties.decimals.minimum, 0, name);
    assert.equal(asset.properties.decimals.maximum, MAX_ASSET_DECIMALS, name);
  }
});

// The corridor vocabulary no longer has its own schema definition — it is the
// chain-namespace alternation baked into the asset id pattern (pinned by the
// "asset definitions" test above). What's worth pinning here is that every
// entry in CORRIDORS actually appears as a namespace in that pattern, so a
// corridor added to the client without a matching schema edit is caught, and
// the relay-count bound stays in sync.
test("every CORRIDORS entry appears as a chain namespace in the schemas' asset id pattern, and the relay bound matches", () => {
  for (const name of ["card.schema.json", "index.schema.json"]) {
    const schema = JSON.parse(readFileSync(join(here, "..", "schema", name), "utf8"));
    const idPattern = schema.definitions.asset.properties.id.pattern as string;
    for (const corridor of CORRIDORS) {
      assert.ok(idPattern.includes(`${corridor}:`), `${name}: asset id pattern must embed "${corridor}:"`);
    }
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

// Hardcoded, not re-derived: recomputing via the same helper passes on any mapping.
test("deprecated index fields: a v1 CAIP-19 card reduces to both the new ids and the derived v0 fields", () => {
  const regtest = reduceNetwork(fixture("valid", "solvers"), "regtest", FIXED_META);
  assert.equal(regtest.ok, true);
  const evm = regtest.index!.markets[0];
  assert.equal(evm.base_asset.id, "arkade:regtest/slip44:1");
  assert.equal(evm.quote_asset.id, "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.equal(evm.pair, "BTC/eip155:USDC");
  assert.equal(evm.base_corridor, undefined, "an arkade side omits its corridor, as in v0");
  assert.equal(evm.quote_corridor, "eip155");

  const bitcoin = reduceNetwork(fixture("valid", "solvers"), "bitcoin", FIXED_META);
  const bolt11 = bitcoin.index!.markets.find((m) => m.solver === "corridor-solver")!;
  assert.equal(bolt11.quote_asset.id, "bolt11:bitcoin/slip44:0");
  assert.equal(bolt11.pair, "BTC/lightning:BTC");
  assert.equal(bolt11.quote_corridor, "lightning");
  assert.ok(!bolt11.pair!.includes("bolt11"), "a v0 consumer has never heard of the bolt11 namespace");

  const signet = reduceNetwork(fixture("valid", "solvers"), "signet", FIXED_META);
  const bothLegs = signet.index!.markets.find((m) => m.base_corridor !== undefined)!;
  assert.equal(bothLegs.pair, "lightning:BTC/onchain:BTC");
  assert.equal(bothLegs.base_corridor, "lightning");
  assert.equal(bothLegs.quote_corridor, "onchain");
});

test("deprecated index fields are derived from the asset ids, not carried from the card", () => {
  const card = JSON.parse(readFileSync(fixture("valid", "solvers", "bitcoin", "corridor-solver.json"), "utf8"));
  for (const key of ["pair", "base_corridor", "quote_corridor"]) {
    assert.equal(card.markets[0][key], undefined, `the card must not carry ${key}`);
  }

  const leg = (id: string) => ({ quote_asset: { id, name: "Bitcoin", ticker: "BTC", decimals: 8 } });
  assert.equal(legacyMarketCorridor(leg("bolt11:bitcoin/slip44:0"), "quote"), "lightning");
  assert.equal(legacyMarketCorridor(leg("bitcoin:bitcoin/slip44:0"), "quote"), "onchain");
  assert.equal(legacyMarketCorridor(leg("eip155:1/slip44:60"), "quote"), "eip155");
  assert.equal(legacyMarketCorridor(leg("arkade:bitcoin/slip44:0"), "quote"), "arkade");
});

// Nothing else here compiles index.schema.json; only third-party consumers do.
test("golden indexes validate under index.schema.json, deprecated fields included", () => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(join(here, "..", "schema", "index.schema.json"), "utf8")));
  for (const network of NETWORKS) {
    const idx = JSON.parse(readFileSync(goldenOf(network), "utf8"));
    assert.ok(validate(idx), `${network}: ${JSON.stringify(validate.errors)}`);
  }
});

// The asset identity rule is declared in three places -- both schemas and the
// client's hand-rolled validator -- and an id that clears one copy but not
// another is a silent routing miss, not an error. The 68-hex reference below
// is duplicated from the shared vector rather than imported, because this
// repo's client and tests are dependency-free by design; a frozen constant is
// safe to duplicate, logic is not.
//
// Source: @arkade-os/sdk ASSET_ID_VECTORS, entry "endianness discriminator
// (gidx 258 = 0x0102)" -- packages/ts-sdk/src/extension/asset/assetIdVectors.json.
// Keep in sync; see ts-sdk plans/asset-id-shared-vectors.md.
//
// The vector itself is just the 68-hex asset-reference half of a CAIP-19 id
// now (see docs/arkade-discovery-spec.md "Asset ids and corridors"); wrap it
// as an Arkade-issued asset id ("arkade:bitcoin/asset:<vector>") to exercise
// the full pattern, the same way a real card would carry it.
const ASSET_ID_VECTOR_REFERENCE = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f200201";
const ASSET_ID_VECTOR = `arkade:bitcoin/asset:${ASSET_ID_VECTOR_REFERENCE}`;
const ASSET_ID_VECTOR_UPPERCASE = `arkade:bitcoin/asset:${ASSET_ID_VECTOR_REFERENCE.toUpperCase()}`;

test("all three copies of the asset identity rule accept the shared vector and reject uppercase", () => {
  const drift = (where: string) =>
    `asset id encoding drifted from @arkade-os/sdk ASSET_ID_VECTORS (${where})`;

  // Both schemas, read as the regex they declare.
  for (const name of ["card.schema.json", "index.schema.json"]) {
    const schema = JSON.parse(readFileSync(join(here, "..", "schema", name), "utf8"));
    const pattern = new RegExp(schema.definitions.asset.properties.id.pattern);
    assert.ok(pattern.test(ASSET_ID_VECTOR), drift(name));
    assert.ok(!pattern.test(ASSET_ID_VECTOR_UPPERCASE), drift(`${name}: uppercase`));
    assert.ok(pattern.test("arkade:bitcoin/slip44:0"), drift(`${name}: slip44 sentinel`));
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
