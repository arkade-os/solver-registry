// Dependency-free runtime validation for solver cards and per-network indexes.
//
// Deliberately hand-rolled rather than schema-driven: Ajv (and most JSON-Schema
// engines) compile validators with `new Function`, which is unavailable under a
// strict browser CSP and throws on Hermes (Expo / React Native). These checks
// mirror `schema/card.schema.json` / `schema/index.schema.json` and the extra
// cross-field rules the reducer enforces, with no `eval` and no dependencies.

import type { AssetInfo, Card, IndexMarket, NetworkIndex } from "./types.ts";
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

/** Collects path-tagged error messages for one validation pass. */
class Errors {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path} ${message}`);
  }
}

function checkIntRange(err: Errors, path: string, v: unknown, min: number, max: number): void {
  if (!isInt(v) || v < min || v > max) {
    err.add(path, `must be an integer in ${min}..${max}`);
  }
}

function checkIntMin(err: Errors, path: string, v: unknown, min: number): void {
  if (!isInt(v) || v < min) {
    err.add(path, `must be an integer >= ${min}`);
  }
}

function checkStringLength(err: Errors, path: string, v: unknown, min: number, max: number): void {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    err.add(path, `must be a string of length ${min}..${max}`);
  }
}

const ASSET_KEYS = new Set(["id", "name", "ticker", "precision"]);

function checkAsset(err: Errors, path: string, v: unknown, strict: boolean): void {
  if (!isObject(v)) {
    err.add(path, "must be an object");
    return;
  }
  if (strict) {
    for (const key of Object.keys(v)) {
      if (!ASSET_KEYS.has(key)) err.add(`${path}/${key}`, "is not an allowed property");
    }
  }
  if (typeof v.id !== "string" || !ASSET_ID.test(v.id)) {
    err.add(`${path}/id`, 'must be "btc" or 68 lowercase hex chars');
  }
  checkStringLength(err, `${path}/name`, v.name, 1, 64);
  checkStringLength(err, `${path}/ticker`, v.ticker, 1, 16);
  checkIntRange(err, `${path}/precision`, v.precision, 0, 18);
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
function checkMarket(err: Errors, path: string, v: unknown, opts: { strict: boolean }): void {
  if (!isObject(v)) {
    err.add(path, "must be an object");
    return;
  }
  if (opts.strict) {
    for (const key of Object.keys(v)) {
      if (!MARKET_KEYS.has(key)) err.add(`${path}/${key}`, "is not an allowed property");
    }
  }

  if (typeof v.pair !== "string" || !PAIR.test(v.pair)) {
    err.add(`${path}/pair`, 'must match "<base>/<quote>"');
  }
  checkAsset(err, `${path}/base_asset`, v.base_asset, opts.strict);
  checkAsset(err, `${path}/quote_asset`, v.quote_asset, opts.strict);

  // pair label must equal the two tickers (identity still lives in the ids).
  const base = v.base_asset as AssetInfo | undefined;
  const quote = v.quote_asset as AssetInfo | undefined;
  if (typeof v.pair === "string" && base?.ticker && quote?.ticker) {
    const expected = `${base.ticker}/${quote.ticker}`;
    if (v.pair !== expected) {
      err.add(`${path}/pair`, `"${v.pair}" does not match asset tickers "${expected}"`);
    }
  }

  if (typeof v.price_feed !== "string" || !v.price_feed.startsWith("https://")) {
    err.add(`${path}/price_feed`, "must be an https:// URL");
  }
  checkIntRange(err, `${path}/price_decimals`, v.price_decimals, 0, 18);
  if (typeof v.invert !== "boolean") {
    err.add(`${path}/invert`, "must be a boolean");
  }
  checkIntRange(err, `${path}/fee_bps`, v.fee_bps, 0, 10000);
  checkIntMin(err, `${path}/min_base_amount`, v.min_base_amount, 1);
  checkIntMin(err, `${path}/max_base_amount`, v.max_base_amount, 1);
  if (
    isInt(v.min_base_amount) &&
    isInt(v.max_base_amount) &&
    v.min_base_amount > v.max_base_amount
  ) {
    err.add(path, `min_base_amount (${v.min_base_amount}) > max_base_amount (${v.max_base_amount})`);
  }
}

const CARD_KEYS = new Set(["version", "name", "discovery_pubkey", "sig", "markets"]);

/**
 * Validate a solver card (e.g. a user-pinned local card). Strict: mirrors
 * `schema/card.schema.json` including rejection of unknown properties.
 */
export function validateCard(input: unknown): ValidationResult<Card> {
  const err = new Errors();
  if (!isObject(input)) {
    return { ok: false, errors: ["/ must be an object"] };
  }
  for (const key of Object.keys(input)) {
    if (!CARD_KEYS.has(key)) err.add(`/${key}`, "is not an allowed property");
  }
  if (input.version !== 0) err.add("/version", "must be 0");
  if (typeof input.name !== "string" || !NAME.test(input.name)) {
    err.add("/name", 'must match "^[a-z0-9-]+$"');
  }
  if (input.discovery_pubkey !== undefined) {
    if (typeof input.discovery_pubkey !== "string" || !PUBKEY.test(input.discovery_pubkey)) {
      err.add("/discovery_pubkey", "must be 64 lowercase hex chars");
    }
  }
  if (input.sig !== undefined) {
    if (typeof input.sig !== "string" || !SIG.test(input.sig)) {
      err.add("/sig", "must be 128 lowercase hex chars");
    }
    if (input.discovery_pubkey === undefined) {
      err.add("/", "sig requires discovery_pubkey");
    }
  }
  if (!Array.isArray(input.markets) || input.markets.length < 1) {
    err.add("/markets", "must be a non-empty array");
  } else {
    input.markets.forEach((m, i) => checkMarket(err, `/markets/${i}`, m, { strict: true }));
  }

  return err.list.length === 0
    ? { ok: true, errors: [], value: input as unknown as Card }
    : { ok: false, errors: err.list };
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
  const err = new Errors();
  if (!isObject(input)) {
    return { ok: false, errors: ["/ must be an object"] };
  }
  if (input.version !== 0) err.add("/version", "must be 0 (unknown index version)");
  if (!isNetwork(input.network)) {
    err.add("/network", "must be one of mainnet, signet, mutinynet");
  } else if (expectedNetwork !== undefined && input.network !== expectedNetwork) {
    err.add("/network", `is "${input.network}" but expected "${expectedNetwork}"`);
  }
  if (!isInt(input.generated_at) || input.generated_at < 0) {
    err.add("/generated_at", "must be a non-negative integer (unix seconds)");
  }
  if (typeof input.commit !== "string" || !COMMIT.test(input.commit)) {
    err.add("/commit", "must be a 40-char hex commit sha");
  }
  if (!Array.isArray(input.markets)) {
    err.add("/markets", "must be an array");
  } else {
    input.markets.forEach((m, i) => {
      checkMarket(err, `/markets/${i}`, m, { strict: false });
      if (isObject(m)) {
        if (typeof m.solver !== "string" || !NAME.test(m.solver)) {
          err.add(`/markets/${i}/solver`, 'must match "^[a-z0-9-]+$"');
        }
        if (
          m.discovery_pubkey !== undefined &&
          (typeof m.discovery_pubkey !== "string" || !PUBKEY.test(m.discovery_pubkey))
        ) {
          err.add(`/markets/${i}/discovery_pubkey`, "must be 64 lowercase hex chars");
        }
      }
    });
  }

  return err.list.length === 0
    ? { ok: true, errors: [], value: input as unknown as NetworkIndex }
    : { ok: false, errors: err.list };
}
