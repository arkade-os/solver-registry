// Shared test fixtures. The Market shape mirrors the schemas; keeping one
// canonical fixture means a schema change is a one-file edit for the suite.
import type { AssetInfo, Market, Side } from "../src/types.ts";
import type { FetchLike } from "../src/feed.ts";

export const BTC: AssetInfo = { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 };

export const USDT_ID = "a".repeat(68);
export const USDT: AssetInfo = { id: USDT_ID, name: "Tether USD", ticker: "USDT", decimals: 6 };

export function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    pair: "BTC/USDT",
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

/** Route-table fetch stub: unknown URLs 404, listed URLs return their body/status. */
export function mockFetch(routes: Record<string, { status?: number; body: string }>): FetchLike {
  return async (url) => {
    const r = routes[url];
    if (!r) return { ok: false, status: 404, text: async () => "not found" };
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => r.body };
  };
}
