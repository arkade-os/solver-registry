import { test } from "node:test";
import assert from "node:assert/strict";
import { orderSolverMarkets, rankSolverMarkets, solverDirectionKey, solverId } from "../src/solverRouting.ts";
import type { DiscoveredMarket } from "../src/discovery.ts";
import type { Market, Side } from "../src/types.ts";
import { makeCorridorMarket, makeMarket } from "./helpers.ts";

const network = "bitcoin";

function candidate(solver: string, market: Partial<Market> = {}, give: Side = "base") {
  const card: DiscoveredMarket = {
    ...makeCorridorMarket("lightning", { fee_bps: 0, ...market }),
    solver,
    source: "https://registry.example",
    sourceType: "registry",
    discovery_pubkey: solver.padEnd(64, "0"),
  };
  return { card, give };
}

const names = (values: readonly { card: DiscoveredMarket }[]) => values.map(({ card }) => card.solver);

test("solverId scopes claimed keys to provenance and stays stable across term refreshes", () => {
  const { card } = candidate("one");
  assert.equal(solverId(card, network), solverId({ ...card, fee_bps: 90 }, network));
  assert.deepEqual(JSON.parse(solverId(card, network)), [network, "registry", card.source, card.solver, card.discovery_pubkey]);
  assert.notEqual(solverId(card, network), solverId({ ...card, solver: "renamed" }, network));
  assert.notEqual(solverId(card, network), solverId({ ...card, source: "other" }, network));
  assert.notEqual(solverId(card, network), solverId({ ...card, sourceType: "local" }, network));
  assert.notEqual(solverId(card, network), solverId({ ...card, discovery_pubkey: "new-key" }, network));
  assert.notEqual(solverId(card, network), solverId(candidate("one").card, "mutinynet"));
  assert.notEqual(solverId(card, network), solverId({ ...card, discovery_pubkey: "different" }, network));
});

test("unsigned identities preserve labels and sources without delimiter collisions", () => {
  const first = { solver: "c", source: "a:b", discovery_pubkey: undefined };
  const second = { solver: "b:c", source: "a", discovery_pubkey: undefined };
  assert.notEqual(solverId(first, network), solverId(second, network));
  assert.notEqual(solverId(first, network), solverId(first, "mutinynet"));
  assert.deepEqual(JSON.parse(solverId(first, network)), [network, "unknown", "a:b", "c", null]);
});

test("a copied key cannot inherit preferences from a different source, name or source type", () => {
  const real = candidate("real");
  const variants = [
    { ...real.card, source: "https://other.example" },
    { ...real.card, solver: "imposter" },
    { ...real.card, sourceType: "local" as const },
  ].map((card) => ({ card, give: real.give }));
  const id = solverId(real.card, network);
  for (const mode of ["manual", "usage"] as const) {
    const ranked = orderSolverMarkets([...variants, real], { network, preferences: { mode, priority: [id], usage: { [id]: 5 } } });
    assert.equal(ranked[0], real);
    assert.deepEqual(ranked.slice(1), variants);
  }
});

test("direction identities include network, ordered canonical assets, and legacy rails", () => {
  const card = makeCorridorMarket("lightning");
  const legacy = makeCorridorMarket("lightning", {
    base_asset: { ...card.base_asset, id: "btc" },
    quote_asset: { ...card.quote_asset, id: "btc" },
    quote_corridor: "lightning",
  });
  assert.deepEqual(JSON.parse(solverDirectionKey(card, "base", network)), [network, card.base_asset.id, card.quote_asset.id]);
  assert.equal(solverDirectionKey(legacy, "base", network), solverDirectionKey(card, "base", network));
  const testnetCard = makeCorridorMarket("lightning", {
    base_asset: { ...card.base_asset, id: "arkade:mutinynet/slip44:1" },
    quote_asset: { ...card.quote_asset, id: "bolt11:mutinynet/slip44:1" },
  });
  assert.equal(solverDirectionKey(legacy, "base", "mutinynet"), solverDirectionKey(testnetCard, "base", "mutinynet"));
  assert.notEqual(solverDirectionKey(card, "base", network), solverDirectionKey(card, "quote", network));
  assert.notEqual(solverDirectionKey(card, "base", network), solverDirectionKey(card, "base", "mutinynet"));
  assert.notEqual(solverDirectionKey(legacy, "base", network), solverDirectionKey({ ...legacy, quote_corridor: "onchain" }, "base", network));
  assert.equal(solverDirectionKey(card, "base", network), solverDirectionKey({ ...card, base_asset: card.quote_asset, quote_asset: card.base_asset }, "quote", network));
});

test("manual priority ignores unknown and duplicate IDs, preserving discovery ties and inputs", () => {
  const candidates = Object.freeze([candidate("a"), candidate("b"), candidate("c"), candidate("b")]);
  const before = structuredClone(candidates);
  const idB = solverId(candidates[1].card, network);
  const priority = Object.freeze(["unknown", idB, idB]);
  assert.deepEqual(names(orderSolverMarkets(candidates, { network, preferences: { priority } })), ["b", "b", "a", "c"]);
  assert.deepEqual(candidates, before);
  assert.deepEqual(priority, ["unknown", idB, idB]);
});

test("usage counts sort descending with manual ties and reject corrupt counts", () => {
  const candidates = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
  const ids = candidates.map(({ card }) => solverId(card, network));
  const prefs = { mode: "usage" as const, priority: [ids[1]], usage: { [ids[0]]: 2, [ids[1]]: 2, [ids[2]]: 7 } };
  assert.deepEqual(names(orderSolverMarkets(candidates, { network, preferences: prefs })), ["c", "b", "a", "d"]);
  for (const corrupt of [-1, NaN, Infinity, "8", null, {}, 0.5]) {
    const usage = { [ids[0]]: corrupt, [ids[2]]: 1 } as Record<string, number>;
    assert.deepEqual(names(orderSolverMarkets(candidates, { network, preferences: { ...prefs, usage } })), ["c", "b", "a", "d"]);
  }
  const inherited = Object.create({ [ids[0]]: 99 });
  assert.deepEqual(names(orderSolverMarkets(candidates, { network, preferences: { ...prefs, usage: inherited } })), ["b", "a", "c", "d"]);
});

test("disabled identities are excluded in every ordering mode without losing saved priority", () => {
  const candidates = [candidate("a"), candidate("b"), candidate("c")];
  const id = solverId(candidates[1].card, network);
  const priority = Object.freeze([id, solverId(candidates[2].card, network)]);
  for (const mode of ["manual", "usage", "cost"] as const) {
    const preferences = { mode, priority, usage: { [id]: 99 }, disabled: Object.freeze([id]) };
    assert.deepEqual(names(orderSolverMarkets(candidates, { network, preferences })), ["c", "a"]);
    assert.deepEqual(preferences.priority, priority);
    assert.deepEqual(names(orderSolverMarkets(candidates, { network, preferences: { ...preferences, disabled: [] } })), ["b", "c", "a"]);
  }
  const copied = { ...candidates[1], card: { ...candidates[1].card, source: "another registry" } };
  assert.deepEqual(orderSolverMarkets([candidates[1], copied], { network, preferences: { disabled: [id] } }), [copied]);
});

test("disabled solvers are not contacted for cost estimates and all-disabled routes stay empty", async () => {
  const candidates = [
    candidate("paused", makeMarket({ price_feed: "https://feed.example/paused" })),
    candidate("live", makeMarket({ price_feed: "https://feed.example/live", min_quote_amount: "1" })),
  ];
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response('{"price":"2"}');
  };
  const options = { network, preferences: { mode: "cost" as const, disabled: [solverId(candidates[0].card, network)] }, amount: { on: "give" as const, value: 2_000n }, fetchImpl };
  assert.deepEqual(names(await rankSolverMarkets(candidates, options)), ["live"]);
  assert.deepEqual(calls, ["https://feed.example/live"]);
  calls.length = 0;
  assert.deepEqual(await rankSolverMarkets(candidates, { ...options, preferences: { ...options.preferences, disabled: candidates.map(({ card }) => solverId(card, network)) } }), []);
  assert.deepEqual(calls, []);
});

test("cost without amount and non-cost ranking never fetch feeds", async () => {
  const candidates = [candidate("a", makeMarket()), candidate("b", makeMarket())];
  const priority = [solverId(candidates[1].card, network)];
  const fetchImpl: typeof fetch = async () => { throw new Error("unexpected feed request"); };
  assert.deepEqual(names(orderSolverMarkets(candidates, { network, preferences: { mode: "cost", priority } })), ["b", "a"]);
  for (const mode of ["cost", "manual", "usage"] as const) {
    assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode, priority }, fetchImpl })), ["b", "a"]);
  }
});

test("cost includes flat fees so the winner can change with amount", async () => {
  const candidates = [candidate("flat", { fee_flat: "100" }), candidate("spread", { fee_bps: 100 })];
  assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode: "cost" }, amount: { on: "give", value: 2_000n } })), ["spread", "flat"]);
  assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode: "cost" }, amount: { on: "give", value: 100_000n } })), ["flat", "spread"]);
});

test("cost uses directional solver fees and supersedes legacy flat fees", async () => {
  const candidates = [
    candidate("a", { fee_bps: 100, fee_flat: "100000", solver_fee: { base: { bps: 0, flat: "10" }, quote: { bps: 100 } } }),
    candidate("b", { fee_bps: 50 }),
  ];
  const opts = { network, preferences: { mode: "cost" as const }, amount: { on: "give" as const, value: 10_000n } };
  assert.deepEqual(names(await rankSolverMarkets(candidates, opts)), ["a", "b"]);
  assert.deepEqual(names(await rankSolverMarkets(candidates.map((item) => ({ ...item, give: "quote" as const })), opts)), ["b", "a"]);
});

test("exact take minimizes required deposit and remains exact above Number.MAX_SAFE_INTEGER", async () => {
  const candidates = [candidate("a", { max_quote_amount: "999999999999999999999999999999", solver_fee: { base: { flat: "2" } } }), candidate("b", { max_quote_amount: "999999999999999999999999999999", solver_fee: { base: { flat: "1" } } })];
  for (const on of ["give", "take"] as const) {
    assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode: "cost" }, amount: { on, value: 9_007_199_254_740_993n } })), ["b", "a"]);
  }
});

test("feed prices rank both exact-give and exact-take estimates in either direction", async () => {
  const candidates = [
    candidate("low", makeMarket({ fee_bps: 0, min_quote_amount: "1", price_feed: "https://feed.example/low" })),
    candidate("high", makeMarket({ fee_bps: 0, min_quote_amount: "1", price_feed: "https://feed.example/high" })),
  ];
  const fetchImpl: typeof fetch = async (url) => new Response(JSON.stringify({ price: String(url).endsWith("high") ? "2" : "1" }));
  for (const on of ["give", "take"] as const) {
    const options = { network, preferences: { mode: "cost" as const }, amount: { on, value: 2_000n }, fetchImpl };
    assert.deepEqual(names(await rankSolverMarkets(candidates, options)), ["high", "low"]);
    assert.deepEqual(names(await rankSolverMarkets(candidates.map((item) => ({ ...item, give: "quote" as const })), options)), ["low", "high"]);
  }
});

test("same-asset corridor cost estimates never request an RFQ or feed", async () => {
  const fetchImpl: typeof fetch = async () => { throw new Error("unexpected request"); };
  const candidates = [candidate("a", { fee_bps: 100 }), candidate("b")];
  assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode: "cost" }, amount: { on: "give", value: 2_000n }, fetchImpl })), ["b", "a"]);
});

test("cost fetches only published feeds, containing failures and unavailable estimates", async () => {
  const candidates = [
    candidate("failed", makeMarket({ price_feed: "https://feed.example/fail" })),
    candidate("disabled", { max_quote_amount: "0", min_quote_amount: "0" }),
    candidate("good", makeMarket({ fee_bps: 0, min_quote_amount: "1", price_feed: "https://feed.example/good" })),
    candidate("missing", makeMarket({ price_feed: undefined })),
  ];
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("fail")) throw new Error("offline");
    return new Response(JSON.stringify({ price: "2" }));
  };
  const priority = [solverId(candidates[3].card, network)];
  assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode: "cost", priority }, amount: { on: "take", value: 2_000n }, fetchImpl })), ["good", "missing", "failed", "disabled"]);
  assert.deepEqual(calls.sort(), ["https://feed.example/fail", "https://feed.example/good"]);
});

test("out-of-range and zero-output estimates rank after executable amounts", async () => {
  const candidates = [candidate("zero", { fee_flat: "5000" }), candidate("limited", { max_quote_amount: "1001" }), candidate("good")];
  assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode: "cost" }, amount: { on: "give", value: 2_000n } })), ["good", "zero", "limited"]);
});

test("carrier charges affect cost and missing required carrier makes an estimate unavailable", async () => {
  const market = makeMarket({ fee_bps: 0, min_quote_amount: "1" });
  const candidates = [candidate("charged", { ...market, charges_delivered_carrier: true }), candidate("plain", { ...market, solver_fee: { base: { flat: "10" } } })];
  const fetchImpl: typeof fetch = async () => new Response('{"price":"1"}');
  const opts = { network, preferences: { mode: "cost" as const }, amount: { on: "give" as const, value: 2_000n }, fetchImpl };
  assert.deepEqual(names(await rankSolverMarkets(candidates, { ...opts, carrierSats: 330n })), ["plain", "charged"]);
  assert.deepEqual(names(await rankSolverMarkets(candidates, opts)), ["plain", "charged"]);
});

test("cost ties follow manual priority and ranking leaves frozen input untouched", async () => {
  const candidates = Object.freeze([Object.freeze(candidate("a")), Object.freeze(candidate("b"))]);
  const before = structuredClone(candidates);
  const priority = Object.freeze([solverId(candidates[1].card, network)]);
  assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode: "cost", priority }, amount: { on: "give", value: 2_000n } })), ["b", "a"]);
  assert.deepEqual(candidates, before);
});

test("cost compares only within direction groups in original group order", async () => {
  const candidates = [candidate("ln-expensive", { fee_bps: 100 }), candidate("chain", makeCorridorMarket("onchain")), candidate("ln-cheap"), candidate("reverse", {}, "quote")];
  assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences: { mode: "cost", priority: [solverId(candidates[1].card, network)] }, amount: { on: "give", value: 2_000n } })), ["ln-cheap", "ln-expensive", "chain", "reverse"]);
});

test("disabled candidates cannot anchor direction order during cost ranking", async () => {
  const candidates = [candidate("paused"), candidate("chain", makeCorridorMarket("onchain")), candidate("live")];
  const preferences = { mode: "cost" as const, disabled: [solverId(candidates[0].card, network)], priority: [solverId(candidates[2].card, network)] };
  assert.deepEqual(names(await rankSolverMarkets(candidates, { network, preferences, amount: { on: "give", value: 2_000n } })), ["chain", "live"]);
});

test("ranking rejects nonpositive supplied amounts", async () => {
  for (const value of [0n, -1n]) {
    await assert.rejects(rankSolverMarkets([], { network, amount: { on: "give", value } }), /positive/);
  }
});

test("pre-aborted ranking rejects even when no feeds or cost estimates are needed", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");
  controller.abort(reason);
  for (const mode of ["manual", "usage", "cost"] as const) {
    await assert.rejects(rankSolverMarkets([candidate("a")], { network, preferences: { mode }, signal: controller.signal }), (error) => error === reason);
  }
});

test("caller cancellation rejects pending cost ranking instead of returning fallback", { timeout: 1_000 }, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const fetchImpl: typeof fetch = async () => {
    started.resolve();
    return new Promise(() => {});
  };
  const ranking = rankSolverMarkets([candidate("pending", makeMarket()), candidate("fallback")], {
    network, preferences: { mode: "cost" }, amount: { on: "give", value: 2_000n }, fetchImpl, signal: controller.signal,
  });
  await started.promise;
  const reason = new Error("user changed amount");
  controller.abort(reason);
  await assert.rejects(ranking, (error) => error === reason);
});

test("an AbortError rejects cost ranking instead of becoming an unavailable estimate", async () => {
  const reason = new DOMException("request aborted", "AbortError");
  const fetchImpl: typeof fetch = async () => { throw reason; };
  await assert.rejects(rankSolverMarkets([candidate("aborted", makeMarket()), candidate("fallback")], {
    network, preferences: { mode: "cost" }, amount: { on: "give", value: 2_000n }, fetchImpl,
  }), (error) => error === reason);
});

test("cost ranking forwards a caller timeout and leaves timed-out feeds last", { timeout: 1_000 }, async () => {
  const fetchImpl: typeof fetch = async (url) => String(url).endsWith("fallback")
    ? new Response('{"price":"1"}')
    : new Promise(() => {});
  const ranked = await rankSolverMarkets([
    candidate("pending", makeMarket()),
    candidate("fallback", makeMarket({ min_quote_amount: "1", price_feed: "https://feed.example/fallback" })),
  ], {
    network, preferences: { mode: "cost" }, amount: { on: "give", value: 2_000n }, fetchImpl, timeoutMs: 5,
  });
  assert.deepEqual(names(ranked), ["fallback", "pending"]);
});

test("cancellation also rejects while a published feed response body is pending", { timeout: 1_000 }, async () => {
  const controller = new AbortController();
  const reading = Promise.withResolvers<void>();
  const body = Promise.withResolvers<string>();
  const response = new Response();
  response.text = async () => {
    reading.resolve();
    return body.promise;
  };
  const fetchImpl: typeof fetch = async () => response;
  const ranking = rankSolverMarkets([candidate("pending", makeMarket())], {
    network, preferences: { mode: "cost" }, amount: { on: "give", value: 2_000n }, fetchImpl, signal: controller.signal,
  });
  await reading.promise;
  controller.abort();
  try {
    await assert.rejects(ranking, { name: "AbortError" });
  } finally {
    body.resolve('{"price":"1"}');
  }
});
