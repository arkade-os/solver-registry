import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchFeedValue, type FeedCacheEntry, type FetchLike } from "../src/feed.ts";

test("fetchFeedValue: uses caller-owned cache when TTL is active", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ price: "65000" }) };
  };
  const feedCache = new Map<string, FeedCacheEntry>();
  const first = await fetchFeedValue("https://feed.example.com/btcusdt", {
    fetchImpl,
    feedCache,
    feedCacheTtlMs: 30_000,
    nowMs: 1_000,
  });
  const second = await fetchFeedValue("https://feed.example.com/btcusdt", {
    fetchImpl,
    feedCache,
    feedCacheTtlMs: 30_000,
    nowMs: 2_000,
  });
  assert.equal(first, "65000");
  assert.equal(second, "65000");
  assert.equal(calls, 1);
});

test("fetchFeedValue: can retry an HTTP 429", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => (name.toLowerCase() === "retry-after" ? "0" : null) },
        text: async () => "rate limited",
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ price: "65001" }) };
  };

  const value = await fetchFeedValue("https://feed.example.com/btcusdt", {
    fetchImpl,
    rateLimitRetries: 1,
  });

  assert.equal(value, "65001");
  assert.equal(calls, 2);
});
