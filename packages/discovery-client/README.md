# @arkade-os/solver-discovery

A tiny, portable **ESM** client for the consumer (maker) side of the
[Arkade Market Discovery Protocol](../../docs/arkade-discovery-spec.md): discover
the price feeds solvers advertise, rank markets, convert amounts, and compute the
`wantAmount` for an offer.

- **Runs everywhere** — browser, Node, and Expo / React Native. The root
  entrypoint has zero runtime dependencies; only global `fetch` is used (and
  it's injectable).
- **No `eval` / `new Function`** — validation is hand-rolled, so it works under a
  strict CSP and on Hermes (React Native), where JSON-Schema engines like Ajv
  fail.
- **Exact math** — prices are `BigInt` rationals and amounts are `BigInt`, so no
  float error ever touches an amount.

## Install

```sh
npm install @arkade-os/solver-discovery
```

## Quick start

```ts
import { discover, listMarkets, bestMarket, quoteOffer } from "@arkade-os/solver-discovery";

// 1. Fetch + merge the registries you follow (plus any pinned local cards).
const { markets, warnings } = await discover({
  registries: ["https://arkade-os.github.io/solver-registry/bitcoin.json"],
});
if (warnings.length) console.warn(warnings);

// 2. List pairs for UI selection, then pick the best market for one pair.
//    `solvable` counts how many markets can pay out each side — don't offer a
//    direction whose receive side is at 0.
console.log(listMarkets(markets).map((p) => `${p.pair} base:${p.solvable.base} quote:${p.solvable.quote}`));
const market = bestMarket(markets, {
  baseId: "btc",
  quoteId: "47004bf4a5fbdb2221f708030528de68ea28f5980044e546b7bb5a352457d1f30000",
  wantSide: "quote", // we give base and receive quote; skips markets that can't pay out quote
});
if (!market) throw new Error("no market solves this side of the pair");

// 3. Quote an offer — fetches the advertised feed and returns a ready plan.
const plan = await quoteOffer(market, { give: "base", giveAmount: "0.01" }); // 0.01 BTC
console.log(`${plan.deposit.display} ${plan.deposit.asset.ticker}`
  + ` -> ${plan.receive.display} ${plan.receive.asset.ticker}`);
// plan.receive.atomic is the wantAmount to request; then createOffer(...) as usual.
if (!plan.limits.withinLimits) console.warn("amount is outside the market's size limits");
```

## Amount conversion (Arkade Assets)

Each asset carries a `decimals` field (8 for BTC and most Arkade assets).
Conversion between human and atomic units is exact:

```ts
import { toAtomic, fromAtomic } from "@arkade-os/solver-discovery";

toAtomic("1.5", 8);          // => 150000000n
fromAtomic(150000000n, 8);   // => "1.5"
toAtomic("1.123456789", 8);  // throws: more precision than 8 decimals allow
```

Pricing math always stays in atomic units; `quoteOffer()` does the human⇄atomic
conversion for you using each side's `decimals`.

## Price feed responses

Every market declares both the feed URL and how to read its response:

```json
{
  "price_feed": "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
  "price_feed_schema": { "type": "json", "price_path": "/bitcoin/usd" }
}
```

`price_path` is an RFC 6901 JSON Pointer to a JSON number or numeric string.
Common examples: Binance ticker price uses `/price`; a bare JSON number uses the
empty pointer `""`. The client does not scan unknown response shapes.

## Pin a local card

Users can pin a solver card directly (a raw card, validated against the card
schema), participating in the merge like any registry entry:

```ts
const { markets } = await discover({
  registries: ["https://arkade-os.github.io/solver-registry/bitcoin.json"],
  localCards: [{ card: pastedCardJson }],
});
```

## Expo / React Native

Works out of the box — Hermes ships `fetch`, `AbortController`, and `BigInt`. If
you target an older runtime without global `fetch`, inject one:

```ts
import { discover } from "@arkade-os/solver-discovery";
await discover({ registries, fetchImpl: myFetch });
```

## React

The optional React entrypoint keeps a two-input quote form synchronized. It
fetches the market feed and recalculates the other field whenever the user edits
base or quote:

```tsx
import { useOfferQuote } from "@arkade-os/solver-discovery/react";

function QuoteForm({ market }) {
  const quote = useOfferQuote(market, { give: "base" });

  if (quote.solvable === false) return <p>This market cannot pay out the side you want.</p>;
  return (
    <>
      <input value={quote.baseAmount} onChange={(e) => quote.setBaseAmount(e.target.value)} />
      <input value={quote.quoteAmount} onChange={(e) => quote.setQuoteAmount(e.target.value)} />
      <button disabled={!quote.plan?.limits.withinLimits}>Create offer</button>
    </>
  );
}
```

`useOfferQuote(market, opts)` returns the active input, both display amounts,
the latest `OfferPlan`, loading/error state, and setters for base/quote or
give/want fields. `quote.solvable` says whether the market declares limits for
— can pay out — the side received under `give` (null while no market is
selected), and `quote.plan?.receive.atomic` is the `wantAmount` to request.

The package does not install React for you: importing
`@arkade-os/solver-discovery/react` requires React in the app, while the root
package entrypoint does not import React.

## Core API

| Export | Purpose |
|---|---|
| `discover(opts)` | Fetch + merge + dedupe + rank markets across registries and local cards. Defaults to `network: "bitcoin"`. Registry failures are isolated. |
| `fetchIndex(url, opts)` | Fetch + validate a single per-network index (never throws). Defaults to `network: "bitcoin"`. |
| `listMarkets(markets)` | List available id pairs, how many solver candidates each pair has, and how many can pay out each side (`solvable.base` / `solvable.quote`). |
| `selectMarkets(markets, {baseId, quoteId, wantSide?, wantAmount?})` / `bestMarket(..., {cursor?})` | Filter to one id pair — and optionally to markets that can pay out `wantSide`, sized by `wantAmount` on that side — keeping the ranking. `cursor: 1` selects the second-ranked market. |
| `sideLimits(market, side)` | The side's `{ min, max }` bounds as exact bigints, or `null` when the solver cannot pay that side out — disabled (`max = "0"`) or carrying malformed/validation-rejected bounds. The single per-side solvability + size-bound primitive. |
| `quoteOffer(market, {give, giveAmount \| wantAmount, safetyBps?})` | Fetch the feed and build a full `OfferPlan` (human in/out). |
| `planOffer({market, give, giveAmount \| wantAmount, feedValue, safetyBps?})` | Same, from an already-fetched feed value (pure/sync). |
| `priceMarket(market, {deposit, direction, safetyBps?})` | Lower-level: fetch feed → atomic `Quote` (`wantAmount`). |
| `fetchFeedValue(url, schema, opts?)` | Fetch a raw feed and extract the numeric price using the market's `price_feed_schema`. |
| `quoteMarket` / `deriveAtomicPrice` / `computeWantAmount` | Pure pricing primitives (exact rationals / BigInt). |
| `toAtomic` / `fromAtomic` / `displayPrice` | Decimals-aware conversion. |
| `validateCard` / `validateIndex` | Dependency-free, `eval`-free schema validation. |

`give: "base"` deposits the base asset and receives the quote; `give: "quote"`
is the reverse (priced with `1/P`). Pass exactly one of `giveAmount` or
`wantAmount`: `giveAmount` fixes the deposit and computes the requested
receive amount, while `wantAmount` fixes the requested receive amount and
computes the minimum deposit. `safetyBps` defaults to `50` — the cushion that
absorbs feed movement between funding and fill.

Markets carry size limits for both sides (`min|max_base_amount`,
`min|max_quote_amount`) as decimal strings of atomic units — exact past 2^53,
where JSON numbers silently round — and `max = "0"` disables a side: the solver
cannot pay it out, so a market with zeroed base bounds only serves
`give: "base"`. Plans check the received side: `plan.limits.min === null` means
the market cannot pay that side at all, and `plan.limits.withinLimits` says
whether the received amount sits inside `[min, max]`.

## Roadmap

**Chained (multi-hop) offers** — not yet supported: `bestMarket`/`quoteOffer` match
direct `(baseId, quoteId)` pairs only. Planned: treat markets as directed edges
over canonical asset ids and route through intermediates (BTC → USDT → USDC)
via `findRoutes` / `planRoute` / `quoteRoute`, ranking routes by the compounded
net multiplier `∏(1 − (fee_bps + safety_bps)/10000)` and checking size limits
per hop at plan time. Note the protocol caveat: each hop executes as a separate
Arkade offer, so a chained route is **not atomic** — plans are indicative and
routing will be opt-in, never a silent fallback inside `quoteOffer()`. Full spec and
API design: [#1](https://github.com/arkade-os/solver-registry/issues/1).

## Develop

```sh
pnpm install
pnpm test        # node --test, dependency-free, runs the .ts directly
pnpm typecheck
pnpm build       # emits dist/*.js + *.d.ts
```

## Release

From the repo root, publish a patch, minor, or major release:

```sh
npm run release:client -- patch
```

The last argument must be `patch`, `minor`, or `major`. The script must be run
from `master` with a clean git tree, runs the package tests/typecheck/build, bumps
`packages/discovery-client/package.json` with `npm version <level>
--no-git-tag-version`, publishes to npm, then creates a release commit and a
`solver-discovery-vX.Y.Z` tag, and pushes both `master` and the tag to `origin`.

You can also run the same workflow from this package directory:

```sh
npm run release -- minor
```

Before running it, make sure you are logged in to npm with publish rights for
the `@arkade-os` scope.
