// @arkade-os/solver-discovery — a portable ESM client for discovering solver price
// feeds from Arkade solver registries. Runs in browsers, Node, and Expo /
// React Native. The root entrypoint has zero runtime dependencies (global
// `fetch` only); the optional ./react subpath imports React.
//
// Typical flow:
//   const { markets } = await discover({ registries: [url] }); // defaults to bitcoin
//   const market = bestMarket(markets, { baseId: "btc", quoteId: DEPIX_ID, wantSide: "quote" });
//   const plan   = await quoteOffer(market, { give: "base", giveAmount: "0.01" });
//   // plan.receive.display is the human amount received; plan.receive.atomic the
//   // wantAmount to request; then createOffer(...) as usual.

export * from "./types.ts";
export * from "./validate.ts";
export * from "./pricing.ts";
export * from "./assets.ts";
export * from "./offer.ts";
export * from "./feed.ts";
export * from "./discovery.ts";
