// Shared test fixtures. The Market shape mirrors the schemas; keeping one
// canonical fixture means a schema change is a one-file edit for the suite.
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { cardDigest } from "../src/canonical.ts";
import type { AssetInfo, Market, Side } from "../src/types.ts";
import type { FetchLike } from "../src/feed.ts";

/** BIP340 test-vector secret keys #1, #0 and #2, with their x-only pubkeys. */
export const KEYS = [
  "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef",
  "0000000000000000000000000000000000000000000000000000000000000003",
  "c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9",
].map((sk) => ({ sk, pk: bytesToHex(schnorr.getPublicKey(hexToBytes(sk))) }));

export function signed<T extends object>(card: T, sk = KEYS[0].sk): T & { sig: string } {
  return { ...card, sig: bytesToHex(schnorr.sign(cardDigest(card as Record<string, unknown>), hexToBytes(sk))) };
}

export const BTC: AssetInfo = { id: "arkade:bitcoin/slip44:0", name: "Bitcoin", ticker: "BTC", decimals: 8 };

export const USDT_ID = `arkade:bitcoin/asset:${"a".repeat(68)}`;
export const USDT: AssetInfo = { id: USDT_ID, name: "Tether USD", ticker: "USDT", decimals: 6 };

export function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    base_asset: { ...BTC },
    quote_asset: { ...USDT },
    price_feed: "https://feed.example.com/btcusdt",
    price_feed_schema: { type: "json", price_path: "/price" },
    price_decimals: 0,
    fee_bps: 30,
    // Both sides enabled: the default market solves both directions.
    min_base_amount: "1000",
    max_base_amount: "5000000",
    min_quote_amount: "1000000",
    max_quote_amount: "1000000000000000",
    ...overrides,
  };
}

/** A one-sided market: the other side's bounds are zeroed (max = "0" disables). */
export function makeOneSidedMarket(solves: Side, overrides: Partial<Market> = {}): Market {
  const disabled =
    solves === "base"
      ? { min_quote_amount: "0", max_quote_amount: "0" }
      : { min_base_amount: "0", max_base_amount: "0" };
  return makeMarket({ ...disabled, ...overrides });
}

/** The corridor's chain namespace, keyed by its old pre-bundling name for test-call convenience. */
const CORRIDOR_ID: Record<"lightning" | "onchain", string> = {
  lightning: "bolt11:bitcoin/slip44:0",
  onchain: "bitcoin:bitcoin/slip44:0",
};

/**
 * A same-asset corridor (RFQ) market: BTC on both sides, the quote side
 * settling on `corridor`, no feed fields — the price is identically 1 and
 * fee_bps plus fee_flat are the whole price.
 */
export function makeCorridorMarket(
  corridor: "lightning" | "onchain",
  overrides: Partial<Market> = {},
): Market {
  return {
    base_asset: { ...BTC },
    quote_asset: { ...BTC, id: CORRIDOR_ID[corridor] },
    fee_bps: 25,
    min_base_amount: "1000",
    max_base_amount: "5000000",
    min_quote_amount: "1000",
    max_quote_amount: "5000000",
    ...overrides,
  };
}

/** Route-table fetch stub: unknown URLs 404, listed URLs return their body/status. */
export function mockFetch(routes: Record<string, { status?: number; body: string }>): FetchLike {
  return async (url) => {
    const r = routes[url];
    if (!r) return { ok: false, status: 404, text: async () => "not found" };
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => r.body };
  };
}
