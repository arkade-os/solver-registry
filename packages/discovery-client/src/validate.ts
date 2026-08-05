// Dependency-free runtime validation for solver cards and per-network indexes.
//
// Deliberately hand-rolled rather than schema-driven: Ajv (and most JSON-Schema
// engines) compile validators with `new Function`, which is unavailable under a
// strict browser CSP and throws on Hermes (Expo / React Native). These checks
// mirror `schema/card.schema.json` / `schema/index.schema.json` and the extra
// cross-field rules the reducer enforces, with no `eval` and no dependencies.

import type { AssetInfo, Card, NetworkIndex, Side } from "./types.ts";
import {
  AMOUNT_PATTERN,
  ASSET_KEYS,
  CORRIDOR_KEYS,
  CORRIDORS,
  LIMIT_KEYS,
  MAX_ASSET_DECIMALS,
  MAX_RELAYS,
  isAmount,
  isCorridor,
  isNetwork,
  isRfqMarket,
  marketCorridor,
  pairSideLabel,
} from "./types.ts";

export interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  /** Present only when ok === true. */
  value?: T;
}

const ASSET_ID = /^(btc|[0-9a-f]{68})$/;
const NAME = /^[a-z0-9-]+$/;
// A pair side is a ticker, optionally prefixed by a non-default corridor
// ("lightning:BTC"); the arkade corridor is unmarked. Derived from CORRIDORS
// so a new corridor can't leave this behind; the schemas' copy of the
// pattern is pinned to CORRIDORS by tests.
const PAIR_SIDE = `(?:(?:${CORRIDORS.filter((c) => c !== "arkade").join("|")}):)?[A-Za-z0-9._-]{1,16}`;
const PAIR = new RegExp(`^${PAIR_SIDE}/${PAIR_SIDE}$`);
const PUBKEY = /^[0-9a-f]{64}$/;
// ponytail: RELAY is looser than the schema's `format: uri` — full URI
// validation needs a spec-grade parser (Ajv brings one; this dependency-free
// client does not), and the operative guarantees — wss scheme, no whitespace
// — are what the checks downstream rely on. The reducer still applies the
// strict schema to everything that merges; tighten here only if a malformed
// relay ever survives to a maker.
const RELAY = /^wss:\/\/[^\s]+$/;
// ponytail: format-only — this client never verifies a signature (the
// dependency-free constraint again; the reducer verifies at CI, local pins
// are the user's own trust decision). Add verification only if the client
// ever grows a crypto dependency for other reasons.
const SIG = /^[0-9a-f]{128}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

// Errors accumulate as path-tagged strings in a plain array; these helpers
// cover the repeated field-check shapes so each rule lives in one place.

function add(errors: string[], path: string, message: string): void {
  errors.push(`${path} ${message}`);
}

function checkPattern(errors: string[], path: string, v: unknown, re: RegExp, message: string): void {
  if (typeof v !== "string" || !re.test(v)) add(errors, path, message);
}

function checkIntRange(errors: string[], path: string, v: unknown, min: number, max: number): void {
  if (!isInt(v) || v < min || v > max) add(errors, path, `must be an integer in ${min}..${max}`);
}

function checkStringLength(errors: string[], path: string, v: unknown, min: number, max: number): void {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    add(errors, path, `must be a string of length ${min}..${max}`);
  }
}

function checkAllowedKeys(errors: string[], path: string, obj: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) add(errors, `${path}/${key}`, "is not an allowed property");
  }
}

const ASSET_KEY_SET = new Set<string>(ASSET_KEYS);
const PRICE_FEED_SCHEMA_KEYS = new Set(["type", "price_path"]);

function checkAsset(errors: string[], path: string, v: unknown, strict: boolean): void {
  if (!isObject(v)) {
    add(errors, path, "must be an object");
    return;
  }
  if (strict) checkAllowedKeys(errors, path, v, ASSET_KEY_SET);
  checkPattern(errors, `${path}/id`, v.id, ASSET_ID, 'must be "btc" or 68 lowercase hex chars');
  checkStringLength(errors, `${path}/name`, v.name, 1, 64);
  checkStringLength(errors, `${path}/ticker`, v.ticker, 1, 16);
  checkIntRange(errors, `${path}/decimals`, v.decimals, 0, MAX_ASSET_DECIMALS);
}

function checkPriceFeedSchema(errors: string[], path: string, v: unknown, strict: boolean): void {
  if (!isObject(v)) {
    add(errors, path, "must be an object");
    return;
  }
  if (strict) checkAllowedKeys(errors, path, v, PRICE_FEED_SCHEMA_KEYS);
  if (v.type !== "json") add(errors, `${path}/type`, 'must be "json"');
  checkPattern(errors, `${path}/price_path`, v.price_path, JSON_POINTER, "must be an RFC 6901 JSON Pointer");
}

const MARKET_KEYS = new Set([
  "pair",
  "base_asset",
  "quote_asset",
  "base_corridor",
  "quote_corridor",
  "price_feed",
  "price_feed_schema",
  "price_decimals",
  "fee_bps",
  "min_base_amount",
  "max_base_amount",
  "min_quote_amount",
  "max_quote_amount",
]);

const LIMIT_SIDES = [LIMIT_KEYS.base, LIMIT_KEYS.quote] as const;

type LimitKey = (typeof LIMIT_SIDES)[number]["min" | "max"];

/**
 * Cross-field size-limit rules, shared with the reducer (`scripts/reduce.ts`
 * imports this) so CI and clients reject the same cards with the same words:
 * per-side min <= max, min >= 1 on an enabled side (max > 0), and at least one
 * side enabled. Bounds compare as exact bigints. Encoding errors are the
 * schema layer's job — sides whose fields are not canonical decimal strings
 * are skipped here.
 */
export function marketLimitErrors(market: { [key in LimitKey]?: unknown }): string[] {
  const errors: string[] = [];
  let checkedSides = 0;
  let enabledSides = 0;
  for (const { min: minKey, max: maxKey } of LIMIT_SIDES) {
    const minRaw = market[minKey];
    const maxRaw = market[maxKey];
    if (!isAmount(minRaw) || !isAmount(maxRaw)) continue;
    checkedSides++;
    const min = BigInt(minRaw);
    const max = BigInt(maxRaw);
    if (min > max) {
      errors.push(`${minKey} (${minRaw}) > ${maxKey} (${maxRaw})`);
    } else if (max > 0n && min < 1n) {
      errors.push(`${minKey} must be >= 1 when ${maxKey} > 0`);
    }
    if (max > 0n) enabledSides++;
  }
  if (checkedSides === LIMIT_SIDES.length && enabledSides === 0) {
    errors.push("must enable size limits for at least one side (max > 0)");
  }
  return errors;
}

/**
 * The pair-label rule, shared with the reducer: `pair` must equal
 * "<base-label>/<quote-label>", where a side's label is its ticker on the
 * arkade corridor and "<corridor>:<ticker>" otherwise. Returns the error
 * message, or null when it matches — or when the fields are too malformed to
 * compare, which the schema layer reports instead.
 */
export function marketPairError(market: {
  pair?: unknown;
  base_asset?: unknown;
  quote_asset?: unknown;
  base_corridor?: unknown;
  quote_corridor?: unknown;
}): string | null {
  const base = (market.base_asset as AssetInfo | undefined)?.ticker;
  const quote = (market.quote_asset as AssetInfo | undefined)?.ticker;
  if (typeof market.pair !== "string" || typeof base !== "string" || typeof quote !== "string") {
    return null;
  }
  const expected = `${pairSideLabel(marketCorridor(market, "base"), base)}/${pairSideLabel(
    marketCorridor(market, "quote"),
    quote,
  )}`;
  return market.pair === expected ? null : `pair "${market.pair}" does not match the sides' labels "${expected}"`;
}

const FEED_KEYS = ["price_feed", "price_feed_schema", "price_decimals"] as const;

/**
 * Corridor cross-field rules, shared with the reducer so CI and clients
 * reject the same cards with the same words. Data-dependent, so they live
 * here rather than in the JSON schemas (draft-07 cannot compare two fields):
 *
 * - the two legs (corridor + asset id) must differ — a market trading a leg
 *   against itself is a null trade, and the pre-corridor "BTC/BTC" shape it
 *   used to smuggle is exactly the ambiguity corridors remove;
 * - when exactly one side is on the arkade corridor it must be the base
 *   side, so equivalent corridor markets group under one canonical key;
 * - a same-asset market prices identically at 1: the feed fields must be
 *   absent (`fee_bps` is the whole spread; executable terms arrive by RFQ);
 * - a cross-asset market needs all three feed fields — the schema no longer
 *   requires them unconditionally, so their presence is enforced here.
 *
 * Shape-defensive: sides whose corridor field is present but not a known
 * corridor are reported here (mirroring the schema enum) and read as arkade
 * for the remaining rules.
 */
export function marketCorridorErrors(market: {
  [key in (typeof CORRIDOR_KEYS)[Side] | (typeof FEED_KEYS)[number]]?: unknown;
} & {
  base_asset?: unknown;
  quote_asset?: unknown;
}): string[] {
  const errors: string[] = [];
  for (const side of ["base", "quote"] as const) {
    const raw = market[CORRIDOR_KEYS[side]];
    if (raw !== undefined && !isCorridor(raw)) {
      errors.push(`${CORRIDOR_KEYS[side]} must be one of ${CORRIDORS.join(", ")}`);
    }
  }

  const baseId = (market.base_asset as AssetInfo | undefined)?.id;
  const quoteId = (market.quote_asset as AssetInfo | undefined)?.id;
  if (typeof baseId !== "string" || typeof quoteId !== "string") return errors;

  const baseCorridor = marketCorridor(market, "base");
  const quoteCorridor = marketCorridor(market, "quote");
  if (baseId === quoteId && baseCorridor === quoteCorridor) {
    errors.push("market legs must differ: same corridor and asset on both sides is a null trade");
  }
  // ponytail: fires only when EXACTLY one side is arkade — a market with
  // both sides off-rail (e.g. lightning:BTC / onchain:BTC, a classic
  // submarine-swap market) is permitted with no canonical leg order, so its
  // two orientations form two index groups; impose an order here (and in the
  // spec) only if rail-to-rail listings become real and need to aggregate.
  if (quoteCorridor === "arkade" && baseCorridor !== "arkade") {
    errors.push("the arkade-corridor side must be the base side when only one side is arkade");
  }

  const presentFeedKeys = FEED_KEYS.filter((key) => market[key] !== undefined);
  if (baseId === quoteId) {
    for (const key of presentFeedKeys) {
      errors.push(`${key} must be absent on a same-asset market (the price is identically 1; fee_bps is the spread)`);
    }
  } else {
    for (const key of FEED_KEYS) {
      if (market[key] === undefined) {
        errors.push(`${key} is required when the sides carry different assets`);
      }
    }
  }
  return errors;
}

/**
 * Validate the market fields common to cards and index entries. Unknown keys
 * are rejected only when `strict` is set (cards); index consumers stay
 * forward-compatible with new fields the reducer might add.
 */
function checkMarket(errors: string[], path: string, v: unknown, strict: boolean): void {
  if (!isObject(v)) {
    add(errors, path, "must be an object");
    return;
  }
  if (strict) checkAllowedKeys(errors, path, v, MARKET_KEYS);

  checkPattern(
    errors,
    `${path}/pair`,
    v.pair,
    PAIR,
    'must be "<base>/<quote>" where a non-arkade side is corridor-prefixed, e.g. "BTC/lightning:BTC"',
  );
  checkAsset(errors, `${path}/base_asset`, v.base_asset, strict);
  checkAsset(errors, `${path}/quote_asset`, v.quote_asset, strict);

  // pair label must equal the sides' labels (identity still lives in the
  // corridor-qualified leg ids).
  const pairError = marketPairError(v);
  if (pairError) add(errors, path, pairError);

  // Feed fields are format-checked when present; whether they must be
  // present or absent is the corridor rule set's call (marketCorridorErrors,
  // below), since it depends on whether the sides carry the same asset.
  // https only, matching the schemas — a laxer check here would admit local
  // cards the reducer rejects.
  if (v.price_feed !== undefined && (typeof v.price_feed !== "string" || !v.price_feed.match(/^https:\/\//))) {
    add(errors, `${path}/price_feed`, "must be an https:// URL");
  }
  if (v.price_feed_schema !== undefined) {
    checkPriceFeedSchema(errors, `${path}/price_feed_schema`, v.price_feed_schema, strict);
  }
  if (v.price_decimals !== undefined) {
    checkIntRange(errors, `${path}/price_decimals`, v.price_decimals, 0, 18);
  }
  checkIntRange(errors, `${path}/fee_bps`, v.fee_bps, 0, 10000);
  for (const message of marketCorridorErrors(v)) add(errors, path, message);

  // Per-side size bounds, always present as canonical decimal strings; the
  // cross-field rules (min <= max, min >= 1 when enabled, one side enabled)
  // live in marketLimitErrors, shared with the reducer.
  for (const { min, max } of LIMIT_SIDES) {
    for (const key of [min, max]) {
      checkPattern(
        errors,
        `${path}/${key}`,
        v[key],
        AMOUNT_PATTERN,
        'must be a decimal string of atomic units ("0" disables the side)',
      );
    }
  }
  for (const message of marketLimitErrors(v)) add(errors, path, message);
}

/** Whether any of a card's markets has a non-arkade corridor (shape-defensive). */
export function cardHasRfqMarket(card: { markets?: unknown }): boolean {
  return Array.isArray(card.markets) && card.markets.some((m) => isObject(m) && isRfqMarket(m));
}

/**
 * The card-level RFQ rendezvous rule, shared with the reducer: a card whose
 * markets include any non-arkade corridor advertises where makers negotiate,
 * so `discovery_pubkey` and `relays` are required. (For pure spot cards they
 * stay optional — the PR is the authentication and there is nothing to
 * contact.) The registry additionally requires `sig` on such cards — that
 * check lives in the reducer, not here: the signature authenticates the
 * listing, while a user-pinned local card is the user's own trust decision
 * and this dependency-free client carries no verification code.
 */
export function cardRfqErrors(card: {
  discovery_pubkey?: unknown;
  relays?: unknown;
  markets?: unknown;
}): string[] {
  if (!cardHasRfqMarket(card)) return [];
  const errors: string[] = [];
  for (const key of ["discovery_pubkey", "relays"] as const) {
    if (card[key] === undefined) {
      errors.push(`${key} is required when any market has a non-arkade corridor (the RFQ rendezvous must be self-authenticating)`);
    }
  }
  return errors;
}

function checkRelays(errors: string[], path: string, v: unknown): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_RELAYS) {
    add(errors, path, `must be an array of 1..${MAX_RELAYS} relay URLs`);
    return;
  }
  v.forEach((relay, i) => {
    checkPattern(errors, `${path}/${i}`, relay, RELAY, "must be a wss:// URL");
  });
}

/** An index entry is a market plus reducer-added provenance (`solver`, optional pubkey/relays). */
function checkIndexMarket(errors: string[], path: string, v: unknown): void {
  checkMarket(errors, path, v, false);
  if (!isObject(v)) return;
  checkPattern(errors, `${path}/solver`, v.solver, NAME, 'must match "^[a-z0-9-]+$"');
  if (v.discovery_pubkey !== undefined) {
    checkPattern(errors, `${path}/discovery_pubkey`, v.discovery_pubkey, PUBKEY, "must be 64 lowercase hex chars");
  }
  checkRelays(errors, `${path}/relays`, v.relays);
}

const CARD_KEYS = new Set(["version", "name", "discovery_pubkey", "sig", "relays", "markets"]);

/**
 * Validate a solver card (e.g. a user-pinned local card). Strict: mirrors
 * `schema/card.schema.json` including rejection of unknown properties.
 *
 * Registry listing requires strictly more than this: the reducer additionally
 * demands a valid `sig` on any card with a corridor market. This validator
 * deliberately omits that check — pinning a local card is the user's own
 * trust decision, and this dependency-free client carries no verification
 * code — so a corridor card can be `ok: true` here and still be rejected by
 * registry CI until it is signed.
 */
export function validateCard(input: unknown): ValidationResult<Card> {
  if (!isObject(input)) {
    return { ok: false, errors: ["/ must be an object"] };
  }
  const errors: string[] = [];
  checkAllowedKeys(errors, "", input, CARD_KEYS);
  if (input.version !== 0) add(errors, "/version", "must be 0");
  checkPattern(errors, "/name", input.name, NAME, 'must match "^[a-z0-9-]+$"');
  if (input.discovery_pubkey !== undefined) {
    checkPattern(errors, "/discovery_pubkey", input.discovery_pubkey, PUBKEY, "must be 64 lowercase hex chars");
  }
  if (input.sig !== undefined) {
    checkPattern(errors, "/sig", input.sig, SIG, "must be 128 lowercase hex chars");
    if (input.discovery_pubkey === undefined) {
      add(errors, "/", "sig requires discovery_pubkey");
    }
  }
  checkRelays(errors, "/relays", input.relays);
  if (!Array.isArray(input.markets) || input.markets.length < 1) {
    add(errors, "/markets", "must be a non-empty array");
  } else {
    input.markets.forEach((m, i) => checkMarket(errors, `/markets/${i}`, m, true));
  }
  for (const message of cardRfqErrors(input)) add(errors, "/", message);

  return errors.length === 0 ? { ok: true, errors: [], value: input as unknown as Card } : { ok: false, errors };
}

/**
 * Validate a per-network index fetched from a registry. Forward-compatible:
 * unknown extra properties are tolerated, but `version`, `network`, and every
 * consumed market field are checked. `expectedNetwork`, when given, must match.
 */
export function validateIndex(input: unknown, expectedNetwork?: string): ValidationResult<NetworkIndex> {
  if (!isObject(input)) {
    return { ok: false, errors: ["/ must be an object"] };
  }
  const errors: string[] = [];
  if (input.version !== 0) add(errors, "/version", "must be 0 (unknown index version)");
  if (!isNetwork(input.network)) {
    add(errors, "/network", "must be one of bitcoin, signet, mutinynet, regtest");
  } else if (expectedNetwork !== undefined && input.network !== expectedNetwork) {
    add(errors, "/network", `is "${input.network}" but expected "${expectedNetwork}"`);
  }
  if (!isInt(input.generated_at) || input.generated_at < 0) {
    add(errors, "/generated_at", "must be a non-negative integer (unix seconds)");
  }
  checkPattern(errors, "/commit", input.commit, COMMIT, "must be a 40-char hex commit sha");
  if (!Array.isArray(input.markets)) {
    add(errors, "/markets", "must be an array");
  } else {
    input.markets.forEach((m, i) => checkIndexMarket(errors, `/markets/${i}`, m));
  }

  return errors.length === 0
    ? { ok: true, errors: [], value: input as unknown as NetworkIndex }
    : { ok: false, errors };
}
