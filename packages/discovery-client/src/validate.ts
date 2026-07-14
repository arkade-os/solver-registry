// Dependency-free runtime validation for solver cards and per-network indexes.
//
// Deliberately hand-rolled rather than schema-driven: Ajv (and most JSON-Schema
// engines) compile validators with `new Function`, which is unavailable under a
// strict browser CSP and throws on Hermes (Expo / React Native). These checks
// mirror `schema/card.schema.json` / `schema/index.schema.json` and the extra
// cross-field rules the reducer enforces, with no `eval` and no dependencies.

import type { AssetInfo, Card, NetworkIndex } from "./types.ts";
import { isNetwork } from "./types.ts";

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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
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

function checkIntMin(errors: string[], path: string, v: unknown, min: number): void {
  if (!isInt(v) || v < min) add(errors, path, `must be an integer >= ${min}`);
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

const ASSET_KEYS = new Set(["id", "name", "ticker", "precision"]);

function checkAsset(errors: string[], path: string, v: unknown, strict: boolean): void {
  if (!isObject(v)) {
    add(errors, path, "must be an object");
    return;
  }
  if (strict) checkAllowedKeys(errors, path, v, ASSET_KEYS);
  checkPattern(errors, `${path}/id`, v.id, ASSET_ID, 'must be "btc" or 68 lowercase hex chars');
  checkStringLength(errors, `${path}/name`, v.name, 1, 64);
  checkStringLength(errors, `${path}/ticker`, v.ticker, 1, 16);
  checkIntRange(errors, `${path}/precision`, v.precision, 0, 18);
}

const MARKET_KEYS = new Set([
  "pair",
  "base_asset",
  "quote_asset",
  "price_feed",
  "price_decimals",
  "invert",
  "fee_bps",
  "min_base_amount",
  "max_base_amount",
]);

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
  const base = v.base_asset as AssetInfo | undefined;
  const quote = v.quote_asset as AssetInfo | undefined;
  if (typeof v.pair === "string" && base?.ticker && quote?.ticker) {
    const expected = `${base.ticker}/${quote.ticker}`;
    if (v.pair !== expected) {
      add(errors, `${path}/pair`, `"${v.pair}" does not match asset tickers "${expected}"`);
    }
  }

  if (typeof v.price_feed !== "string" || !v.price_feed.startsWith("https://")) {
    add(errors, `${path}/price_feed`, "must be an https:// URL");
  }
  checkIntRange(errors, `${path}/price_decimals`, v.price_decimals, 0, 18);
  if (typeof v.invert !== "boolean") {
    add(errors, `${path}/invert`, "must be a boolean");
  }
  checkIntRange(errors, `${path}/fee_bps`, v.fee_bps, 0, 10000);
  checkIntMin(errors, `${path}/min_base_amount`, v.min_base_amount, 1);
  checkIntMin(errors, `${path}/max_base_amount`, v.max_base_amount, 1);
  if (
    isInt(v.min_base_amount) &&
    isInt(v.max_base_amount) &&
    v.min_base_amount > v.max_base_amount
  ) {
    add(errors, path, `min_base_amount (${v.min_base_amount}) > max_base_amount (${v.max_base_amount})`);
  }
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

  return errors.length === 0
    ? { ok: true, errors: [], value: input as unknown as Card }
    : { ok: false, errors };
}

/**
 * Validate a per-network index fetched from a registry. Forward-compatible:
 * unknown extra properties are tolerated, but `version`, `network`, and every
 * consumed market field are checked. `expectedNetwork`, when given, must match.
 */
export function validateIndex(
  input: unknown,
  expectedNetwork?: string,
): ValidationResult<NetworkIndex> {
  if (!isObject(input)) {
    return { ok: false, errors: ["/ must be an object"] };
  }
  const errors: string[] = [];
  if (input.version !== 0) add(errors, "/version", "must be 0 (unknown index version)");
  if (!isNetwork(input.network)) {
    add(errors, "/network", "must be one of mainnet, signet, mutinynet");
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
