// Shared test fixtures. The Market shape mirrors the schemas; keeping one
// canonical fixture means a schema change is a one-file edit for the suite.
import type { AssetInfo, Market } from "../src/types.ts";
import type { FetchLike } from "../src/feed.ts";

export const BTC: AssetInfo = { id: "btc", name: "Bitcoin", ticker: "BTC", precision: 8 };

export const USDT_ID = "a".repeat(68);
export const USDT: AssetInfo = { id: USDT_ID, name: "Tether USD", ticker: "USDT", precision: 6 };

export function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    pair: "BTC/USDT",
    base_asset: { ...BTC },
    quote_asset: { ...USDT },
    price_feed: "https://feed.example.com/btcusdt",
    price_feed_schema: { type: "json", price_path: "/price" },
    price_decimals: 0,
    fee_bps: 30,
    // Both sides declared: the default market solves both directions.
    min_base_amount: 1000,
    max_base_amount: 5_000_000,
    min_quote_amount: 1_000_000,
    max_quote_amount: 1_000_000_000_000_000,
    ...overrides,
  };
}

/** A one-sided market: drops the other side's bounds from the default market. */
export function makeOneSidedMarket(solves: "base" | "quote", overrides: Partial<Market> = {}): Market {
  const market = makeMarket(overrides);
  if (solves === "base") {
    delete market.min_quote_amount;
    delete market.max_quote_amount;
  } else {
    delete market.min_base_amount;
    delete market.max_base_amount;
  }
  return market;
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
