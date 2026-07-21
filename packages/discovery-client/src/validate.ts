// Dependency-free runtime validation for solver cards and per-network indexes.
//
// Deliberately hand-rolled rather than schema-driven: Ajv (and most JSON-Schema
// engines) compile validators with `new Function`, which is unavailable under a
// strict browser CSP and throws on Hermes (Expo / React Native). These checks
// mirror `schema/card.schema.json` / `schema/index.schema.json` and the extra
// cross-field rules the reducer enforces, with no `eval` and no dependencies.

import type { AssetInfo, Card, NetworkIndex } from "./types.ts";
import { AMOUNT_PATTERN, ASSET_KEYS, LIMIT_KEYS, MAX_ASSET_DECIMALS, isAmount, isNetwork } from "./types.ts";

export interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  /** Present only when ok === true. */
  value?: T;
}

const ASSET_ID = /^(btc|[0-9a-f]{68})$/;
const NAME = /^[a-z0-9-]+$/;
const PAIR = /^[A-Za-z0-9._-]{1,16}\/[A-Za-z0-9._-]{1,16}$/;
const PUBKEY = /^[0-9a-f]{64}$/;
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
 * "<base-ticker>/<quote-ticker>". Returns the error message, or null when it
 * matches — or when the fields are too malformed to compare, which the schema
 * layer reports instead.
 */
export function marketPairError(market: {
  pair?: unknown;
  base_asset?: unknown;
  quote_asset?: unknown;
}): string | null {
  const base = (market.base_asset as AssetInfo | undefined)?.ticker;
  const quote = (market.quote_asset as AssetInfo | undefined)?.ticker;
  if (typeof market.pair !== "string" || typeof base !== "string" || typeof quote !== "string") {
    return null;
  }
  const expected = `${base}/${quote}`;
  return market.pair === expected ? null : `pair "${market.pair}" does not match asset tickers "${expected}"`;
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

  checkPattern(errors, `${path}/pair`, v.pair, PAIR, 'must match "<base>/<quote>"');
  checkAsset(errors, `${path}/base_asset`, v.base_asset, strict);
  checkAsset(errors, `${path}/quote_asset`, v.quote_asset, strict);

  // pair label must equal the two tickers (identity still lives in the ids).
  const pairError = marketPairError(v);
  if (pairError) add(errors, path, pairError);

  if (typeof v.price_feed !== "string" || !v.price_feed.match(/^https?:\/\//)) {
    add(errors, `${path}/price_feed`, "must be an http[s]:// URL");
  }
  checkPriceFeedSchema(errors, `${path}/price_feed_schema`, v.price_feed_schema, strict);
  checkIntRange(errors, `${path}/price_decimals`, v.price_decimals, 0, 18);
  checkIntRange(errors, `${path}/fee_bps`, v.fee_bps, 0, 10000);

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

/** An index entry is a market plus reducer-added provenance (`solver`, optional pubkey). */
function checkIndexMarket(errors: string[], path: string, v: unknown): void {
  checkMarket(errors, path, v, false);
  if (!isObject(v)) return;
  checkPattern(errors, `${path}/solver`, v.solver, NAME, 'must match "^[a-z0-9-]+$"');
  if (v.discovery_pubkey !== undefined) {
    checkPattern(errors, `${path}/discovery_pubkey`, v.discovery_pubkey, PUBKEY, "must be 64 lowercase hex chars");
  }
}

const CARD_KEYS = new Set(["version", "name", "discovery_pubkey", "sig", "markets"]);

/**
 * Validate a solver card (e.g. a user-pinned local card). Strict: mirrors
 * `schema/card.schema.json` including rejection of unknown properties.
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
  if (!Array.isArray(input.markets) || input.markets.length < 1) {
    add(errors, "/markets", "must be a non-empty array");
  } else {
    input.markets.forEach((m, i) => checkMarket(errors, `/markets/${i}`, m, true));
  }

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
