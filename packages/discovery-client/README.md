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
import { discover, bestMarket, quoteOffer } from "@arkade-os/solver-discovery";

// 1. Fetch + merge the registries you follow (plus any pinned local cards).
const { markets, warnings } = await discover({
  registries: ["https://arkade-os.github.io/solver-registry/bitcoin.json"],
});

// 2. Pick the best market for a pair (grouped by canonical asset id, best fee first).
const market = bestMarket(markets, {
  baseId: "btc",
  quoteId: "47004bf4a5fbdb2221f708030528de68ea28f5980044e546b7bb5a352457d1f30000",
});

// 3. Quote an offer — fetches the advertised feed and returns a ready plan.
const plan = await quoteOffer(market, { give: "base", giveAmount: "0.01" }); // 0.01 BTC
console.log(`${plan.deposit.display} ${plan.deposit.asset.ticker}`
  + ` -> ${plan.receive.display} ${plan.receive.asset.ticker}`);
// plan.receive.atomic is the wantAmount to request; then createOffer(...) as usual.
if (!plan.limits.withinLimits) console.warn("amount is outside the market's size limits");
```

## Amount conversion (Arkade Assets)

Each asset carries a `precision` (8 for BTC and most Arkade assets). Conversion
between human and atomic units is exact:

```ts
import { toAtomic, fromAtomic } from "@arkade-os/solver-discovery";

toAtomic("1.5", 8);          // => 150000000n
fromAtomic(150000000n, 8);   // => "1.5"
toAtomic("1.123456789", 8);  // throws: more precision than 8 decimals allow
```

Pricing math always stays in atomic units; `quoteOffer()` does the human⇄atomic
conversion for you using each side's precision.

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

  return (
    <>
      <input value={quote.baseAmount} onChange={(e) => quote.setBaseAmount(e.target.value)} />
      <input value={quote.quoteAmount} onChange={(e) => quote.setQuoteAmount(e.target.value)} />
      <button disabled={!quote.plan}>Create offer</button>
    </>
  );
}
```

`quote.plan?.receive.atomic` is the `wantAmount` to request. The package does
not install React for you: importing `@arkade-os/solver-discovery/react`
requires React in the app, while the root package entrypoint does not import
React.

## API

| Export | Purpose |
|---|---|
| `discover(opts)` | Fetch + merge + dedupe + rank markets across registries and local cards. Defaults to `network: "bitcoin"`. Registry failures are isolated. |
| `fetchIndex(url, opts)` | Fetch + validate a single per-network index (never throws). Defaults to `network: "bitcoin"`. |
| `listMarkets(markets)` | List available id pairs and how many solver candidates each pair has. |
| `selectMarkets(markets, {baseId, quoteId, baseAmount?})` / `bestMarket(..., {cursor?})` | Filter to one id pair (and size), keeping the ranking. `cursor: 1` selects the second-ranked market. |
| `quoteOffer(market, {give, giveAmount \| wantAmount, safetyBps?})` | Fetch the feed and build a full `OfferPlan` (human in/out). |
| `planOffer({market, give, giveAmount \| wantAmount, feedValue, safetyBps?})` | Same, from an already-fetched feed value (pure/sync). |
| `priceMarket(market, {deposit, direction, safetyBps?})` | Lower-level: fetch feed → atomic `Quote` (`wantAmount`). |
| `fetchFeedValue(url, {extractPrice?})` | Fetch a raw feed value and extract the price. |
| `quoteMarket` / `deriveAtomicPrice` / `computeWantAmount` | Pure pricing primitives (exact rationals / BigInt). |
| `toAtomic` / `fromAtomic` / `displayPrice` | Precision-aware conversion. |
| `validateCard` / `validateIndex` | Dependency-free, `eval`-free schema validation. |

React-only export from `@arkade-os/solver-discovery/react`:

| Export | Purpose |
|---|---|
| `useOfferQuote(market, opts)` | Hook for linked base/quote inputs. The last edited side drives the quote and updates the other side. |

`give: "base"` deposits the base asset and receives the quote; `give: "quote"`
is the reverse (priced with `1/P`). Pass exactly one of `giveAmount` or
`wantAmount`: `giveAmount` fixes the deposit and computes the requested
receive amount, while `wantAmount` fixes the requested receive amount and
computes the minimum deposit. `safetyBps` defaults to `50` — the cushion that
absorbs feed movement between funding and fill.

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

Publish manually from this package directory:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
npm publish --access public
```

Before publishing, update `package.json` to the new version and make sure you
are logged in to npm with publish rights for the `@arkade-os` scope. After
publishing, tag the release from the repo root, for example
`git tag solver-discovery-v0.1.0`.
