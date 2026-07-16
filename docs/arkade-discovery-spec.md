# Arkade Market Discovery Protocol — v0

Status: draft. Scope: how makers discover solver markets, prices, fees, and limits for Arkade Intents (banco standing orders). Out of scope: the covenant, the TLV offer format, and the fill path. Those are unchanged; this protocol is purely advisory and adds zero interactivity between maker and solver.

## Design summary

The execution path already needs no interactivity: the maker funds a swap VTXO carrying the TLV offer, and any solver watching the arkd stream can fill it. The covenant enforces the terms and does not bind a specific filler. Discovery therefore only answers one question for the maker: what `wantAmount` for pair Y will clear right now?

v0 is a git repo format (the **registry**) plus a GitHub Action (the **reducer**). Solvers PR a small unsigned JSON card describing their markets. CI validates the cards and reduces them into one flat, sorted index per network. Clients fetch one URL per registry they follow, merge, pick a market, price from its pinned feed, concede the fee plus a safety cushion, and fund the standard offer. No signatures, no relays, no messages to the solver, no solver-side tooling beyond writing a JSON file.

Anyone can run a registry: it's a repo layout and a workflow, not an instance. Clients follow a *set* of registries (shipping with well-known defaults) and can additionally pin solver cards directly, so no repo owner is a gatekeeper or single point of failure — a solver rejected or dropped by every registry is still reachable by any client that adds its card by hand (the token-list pattern).

Trust anchors to each registry repo and its PR review, not to keys. A live-quote layer with signed events is specced as **v1, dormant** — see the appendix; keys enter the protocol there, not before.

## Solver card

One file per solver per network, `solvers/<network>/<name>.json` (networks: `bitcoin`, `signet`, `mutinynet` — same partitioning as arkade-os/asset-registry), submitted and updated by PR. The network lives in the path, not the card: asset IDs are network-scoped, so a pair is only meaningful within its directory, and a solver active on several networks files one card per network.

```json
{
  "version": 0,
  "name": "arklabs-solver",
  "discovery_pubkey": "<64-hex x-only, OPTIONAL>",
  "sig": "<128-hex schnorr, OPTIONAL>",
  "markets": [
    {
      "pair": "BTC/USDT",
      "base_asset": { "id": "btc", "name": "Bitcoin", "ticker": "BTC", "decimals": 8 },
      "quote_asset": { "id": "<asset-id-hex>", "name": "Tether USD", "ticker": "USDT", "decimals": 6 },
      "price_feed": "https://feed.example.com/price?pair=...",
      "price_feed_schema": { "type": "json", "price_path": "/price" },
      "price_decimals": 8,
      "fee_bps": 30,
      "min_base_amount": "1000",
      "max_base_amount": "5000000",
      "min_quote_amount": "1000000",
      "max_quote_amount": "5000000000"
    }
  ]
}
```

Field semantics:

| Field | Meaning |
|---|---|
| `name` | Unique within the network directory; must match the filename. CI enforces. |
| `discovery_pubkey` | Optional in v0, required in v1. The solver's BIP340 identity: signs the card when `sig` is present, and signs v1 quote events. |
| `sig` | Optional in v0, required in v1. BIP340 Schnorr by `discovery_pubkey` over `sha256(canonical_json)`: the card serialized with `sig` removed, keys sorted lexicographically, no whitespace, UTF-8. If present, `discovery_pubkey` is required and CI MUST verify; if absent, the PR is the authentication. |
| `pair` | Human-readable label `<base-ticker>/<quote-ticker>` (e.g. `BTC/USDT`); MUST equal the two asset objects' tickers, CI enforces. Display only — NOT an identity. The market's identity is the id pair (`base_asset.id`, `quote_asset.id`): tickers collide, ids don't. Asset-to-asset pairs are first-class; nothing assumes bitcoin on either side. |
| `base_asset`, `quote_asset` | Per-side asset descriptor: `id` (the canonical identity: `btc` or the serialized AssetId in lowercase hex), `name`, `ticker`, `decimals` (decimal places of the atomic unit, e.g. 8 for BTC ⇒ amounts in sats; the same field the Arkade asset registry metadata carries). `decimals` is for rendering amounts like `min_base_amount`; it plays no role in pricing math, which stays in atomic units. `name`/`ticker` are unverified labels the solver chose — anyone can call an asset "USDT". Clients MUST group, dedupe, and price by `id` only and MAY badge verification via the asset registry. |
| `price_feed` | The exact URL the solver's plugin validates against at fill time. Makers MUST price from this URL, not a substitute. MUST be fetchable from browsers (CORS-permissive), otherwise browser wallets cannot price the pair. The response MUST be JSON. |
| `price_feed_schema` | How to read the numeric feed value from the response. v0 supports `{ "type": "json", "price_path": "<RFC 6901 JSON Pointer>" }`. Examples: Binance ticker price uses `/price`; CoinGecko simple price for `ids=bitcoin&vs_currencies=usd` uses `/bitcoin/usd`; a bare JSON number uses the empty pointer `""`. The pointer MUST resolve to a JSON number or numeric string. Clients MUST NOT infer by scanning arbitrary response bodies. |
| `price_decimals` | How to normalize the feed's value to quote-units-per-base-unit: the feed value divided by `10^price_decimals` MUST be the price in quote-atomic-units per base-atomic-unit. Mirrors the solver Pair config; the feed is always advertised in base/quote terms, never inverted. Independent of the assets' `decimals`: for a feed quoted in display units (quote-display per base-display, e.g. typical exchange tickers) this works out to `base_asset.decimals − quote_asset.decimals`, but for a feed already in atomic terms it does not — derive it from the feed's actual denomination, never from asset `decimals` alone. |
| `fee_bps` | The solver's spread: the promise is that an offer priced at least `fee_bps` (plus a reasonable safety cushion) inside fair value will fill. The solver's fill-time tolerance check is internal and MUST be wide enough to honor this; a solver whose published fee doesn't fill loses flow. |
| `min_base_amount`, `max_base_amount`, `min_quote_amount`, `max_quote_amount` | Per-side trade size bounds as **decimal strings** of that side's atomic units (sats when the side is BTC), canonical form `^(0\|[1-9][0-9]{0,29})$` — no sign, no leading zeros. Strings keep amounts exact: JSON numbers round past 2^53, which cannot hold even one whole token of an 18-decimal asset, and a single canonical encoding keeps card signatures stable. All four are REQUIRED. `max = "0"` disables the side — the solver does not pay it out (solve it) and makers MUST NOT take the direction that receives it; `min` MUST then also be `"0"`. An enabled side has `1 <= min <= max` (compared as integers), and at least one side MUST be enabled. The bound applies to the amount the maker receives (the solver pays) on that side: a solver that zeroes the base bounds only serves makers depositing base to receive quote; enabling both sides serves both directions. |

Keys and signatures are future-proofing, not a v0 requirement: requiring signing tooling just to list a market is friction without a v0 payoff, so a bare card with neither field is fully valid and the PR is the authentication. Solvers that set them up now get continuity — the same key later signs v1 quotes, and card updates become verifiable independent of who opens the PR. No `updated_at`: hand-maintained timestamps rot; freshness is stamped programmatically in the index. No URLs pointing at solver or ark infrastructure (`price_feed` excepted).

## The reducer (GitHub Action)

On every merge to the default branch, CI, independently per network directory:

1. Validates every card against the JSON schema (schema lives in the repo); rejects duplicate `name`s, malformed pairs, per-side `min > max`, a zero `min` on an enabled side, both sides disabled, unknown `version`. Where a card carries `sig`, verifies it against `discovery_pubkey` and rejects on failure.
2. Flattens the network's cards into one market list, each entry carrying its solver's `name` (and `discovery_pubkey` when present; `sig` stays in the card, it is not propagated).
3. Groups by id pair (`base_asset.id`, `quote_asset.id`) — never by the ticker label; within a group, sorts ascending by `fee_bps` (best expected execution first).
4. Emits one index per network — `bitcoin.json`, `signet.json`, `mutinynet.json` — each stamped with its `network`, `generated_at` (unix seconds, set by CI, never by hand), and the source commit hash.
5. Publishes via GitHub Pages / raw URL. A broken card in one network must not block publishing the others.

```json
{
  "version": 0,
  "network": "bitcoin",
  "generated_at": 1783958400,
  "commit": "<git sha>",
  "markets": [
    {
      "pair": "BTC/USDT",
      "solver": "arklabs-solver",
      "discovery_pubkey": "<optional>",
      "base_asset": { "id": "btc", "name": "Bitcoin", "ticker": "BTC", "decimals": 8 },
      "quote_asset": { "id": "<asset-id-hex>", "name": "Tether USD", "ticker": "USDT", "decimals": 6 },
      "price_feed": "...",
      "price_feed_schema": { "type": "json", "price_path": "/price" },
      "price_decimals": 8,
      "fee_bps": 30,
      "min_base_amount": "1000",
      "max_base_amount": "5000000",
      "min_quote_amount": "1000000",
      "max_quote_amount": "5000000000"
    }
  ]
}
```

PR validation runs the same schema checks, so a broken card can't merge. The per-network indexes are the only artifacts clients consume; cards are the only artifact solvers touch.

## Maker flow

1. For each followed registry, fetch the index for the wallet's network — `<base-url>/<network>.json` (TTL-cache ~10 min). Network names follow `arkade-os/ts-sdk`; `bitcoin` is the default main Bitcoin network. Reject unknown `version` or a `network` mismatch; treat an old `generated_at` (suggested: > 7 days) as a staleness warning. Registry failures are isolated: one unreachable or invalid registry never blocks pricing from the others or from locally pinned cards.
2. Merge: union of all markets across followed registries plus local cards, tagged with their source. Drop byte-identical duplicates (the same solver listed in two registries); otherwise entries are distinct per source — `name` is only unique within a registry. Re-rank the merged set per id pair (`base_asset.id`, `quote_asset.id`) ascending by `fee_bps`, source order as tiebreak; the `pair` ticker label is display only and never a grouping key. Filter by id pair, by receive-side solvability (only markets whose receive side is enabled — `max > 0` — qualify; if no market in the merged set solves that side, the direction MUST NOT be offered), and by size against the receive side's bounds. The ranking is a static proxy — the actual execution price still comes from the feed.
3. Local cards: a client MUST let its user add solver cards directly (a URL to a raw card, or pasted JSON), validated against the same card schema, scoped to a network by the user. Local cards participate in the merge like any registry entry, marked as user-added in any UI.
4. Fetch the chosen market's `price_feed`, parse the JSON response, read the scalar selected by `price_feed_schema.price_path`, then derive `P` in quote-units-per-base-unit via `price_decimals`.
5. Compute `wantAmount` (below), then the existing flow: `createOffer` → fund the address with the TLV extension.

There is no liveness signal in v0: solvers are not publicly reachable, so nothing can be probed before funding. `generated_at` and local fill history are the only heuristics. The cost of funding into a dead solver is one cancel transaction.

### Maker pricing

For a deposit `D` in base units at price `P`:

```
wantAmount = floor(D * P * (1 - (fee_bps + safety_bps) / 10000))
```

with `safety_bps` chosen by the client (suggested default: 50). The cushion absorbs feed movement and observation divergence between funding and fill: maker and solver read the same URL at different moments, and the solver's fill-time check runs against its own reading. A larger cushion fills more reliably at a worse price; zero cushion means any divergence leaves the offer sitting. The reverse direction is symmetric with `1/P`. All arithmetic over scaled integers; no floats near amounts.

## Trust model and failure modes

The trust anchor is each registry repo the client follows: PR review is the listing gate, git history is the audit log, HTTPS is transport integrity. No single repo owner is a chokepoint: registries are permissionlessly forkable, clients follow several, and local cards bypass registries entirely — curation power is capped at "not appearing in one list". Consequences, accepted for v0: an index is not self-authenticating from mirrors (clients pin each registry's canonical URL), and a compromised repo or CI can serve a poisoned index — the blast radius is bounded because indexes never control funds, only which offers get created; the covenant still enforces every term, and the worst outcome of any bad entry, poisoned or just wrong, is an unfilled offer and a cancel tx. The same bound is what makes local cards safe to allow. Feed unreachable from the wallet means the pair is unpriceable; surface the error. Front-running between solvers is harmless: the maker is indifferent to who fills.

## Rationale (FAQ)

**Why one flat index per registry instead of clients crawling solver files?** One fetch per followed registry, no per-card fan-out, and validation computed once in CI instead of N times in N clients. Merging a handful of pre-validated indexes client-side is cheap; crawling hundreds of cards is not.

**Why multiple registries and local cards?** So no repo owner becomes a gatekeeper. A registry is a curation, not an authority: clients follow the curations they trust, union them, and can pin any solver's card directly. Delisting from every registry degrades a solver's reach, never its ability to serve clients that know it.

**Why are signatures optional rather than required or absent?** Required would mean every solver needs keygen and signing tooling before it can list, for no v0 payoff — the client's decision doesn't depend on solver identity, since the covenant protects the funds either way, and the PR process already gates listing. Absent would break continuity with v1, where the same key must sign quotes. Optional costs nothing: bare cards list freely, signed cards get CI verification and a stable identity today.

**Why is the solver's fill tolerance not in the card?** It's an internal enforcement knob, not a promise to the client. The client-meaningful number is `fee_bps`: concede that plus a cushion and the offer should fill. Publishing tolerance would leak an implementation parameter, drag derived rules into client code, and tempt clients to price against the band's edge — exactly the offers most likely to sit unfilled under feed divergence.

**Why `fee_bps` as the sort key?** It's the only static, client-meaningful cost of trading against a market. Feeds move; this doesn't, so it's the only honest ranking a static index can make.

**Why JSON Pointer for price feeds?** Existing price APIs are not uniform: Binance exposes a top-level `price`, while CoinGecko's simple endpoint nests by coin and currency. Scanning a response for "the only number" breaks as soon as the provider adds metadata or multiple currencies. JSON Pointer is an IETF-standard way to select exactly one value from a JSON document; JSONPath is more expressive but can select sets of values, which is unnecessary for a price scalar and harder to validate consistently across runtimes.

**Why no `ark_server` or any solver URL?** URLs couple the registry to infrastructure that can be seized, moved, or rotated, and clients have no reason to contact it.

**Why per-side limits?** Two reasons. Denomination: `min_sats` breaks the moment neither side of a pair is BTC, while each side's own atomic units are well-defined for every pair (BTC sides degrade to sats). Directionality: a solver's real constraint is inventory on the side it pays out, and the two sides' inventories are independent — a solver flush with the quote asset but dry on base can serve makers wanting quote and nobody else. Per-side bounds let a solver advertise exactly the direction(s) it can fill, instead of one base-side bound that pretends both directions are always available. `max = 0` *is* the disable switch — every card carries the same four fields, and there is no separate solvability flag to drift out of sync with the bounds.

**Why not iroh or any p2p transport?** A market card is <1KB, read-only, best-effort. Direct connections and gossip solve none of that and reintroduce interactivity and bootstrap infrastructure.

---

## Appendix: v1 — signed live quotes over nostr (dormant)

### Why this layer exists

Three things static-registry pricing cannot provide:

**Liveness.** v0 has no liveness signal at all: solvers sit behind NAT with no public endpoint, so nothing can be probed before funding. A fresh signed quote proves the solver is awake and quoting *now*, and it works structurally under this constraint — the solver publishes outbound to relays, needing no inbound reachability. This is the strongest single argument for activating v1.

**Spread.** Maker and solver observe the feed at different times, so the maker leaves `safety_bps` on the table every trade. A quote signed by the solver — "price Z, valid until T" — removes the ambiguity and lets the cushion shrink toward zero. Matters when solvers compete fees down toward ~10bps; at wide spreads it buys little.

**Accountability.** A signed quote is evidence. Registry-only, a maker cannot prove what the price was when it funded. With signed quotes, a maker holding quote + funding txid + no fill can publish a verifiable report; anyone can check the offer was inside the quote's envelope during its validity.

This is also where keys and signatures enter the protocol — as the thing that makes quotes attributable — and why v0 deliberately omits them: the identity becomes meaningful only when there is a live statement to sign. Why nostr specifically: addressable events give latest-quote-per-(solver, pair) retention for free, NIP-40 expiration gives the validity window, relays already exist, and `discovery_pubkey` is nostr-compatible. No infrastructure to run, ~200 lines per side.

### Quote event

One per (solver, pair):

```
kind: 38173
pubkey: <discovery_pubkey>
tags:
  ["d", "<base-id>/<quote-id>"]   // ids, not tickers — the d tag is an identity, labels collide
  ["expiration", "<created_at + 30>"]        // NIP-40
content: {
  "v": 1,
  "pair": "<base-id>/<quote-id>",
  "price": "1.00020000",
  "fee_bps": 30,
  "min_base_amount": "1000",
  "max_base_amount": "5000000",
  "min_quote_amount": "1000000",
  "max_quote_amount": "5000000000",
  "feed": "https://feed.example.com/price?pair=..."
}
```

`price` is a decimal string in quote-units-per-base-unit, already normalized and net of nothing — the maker still concedes `fee_bps` from it. The commitment: an offer funded before `expiration`, within limits, priced at or inside `price` less `fee_bps`, will be filled. How the solver's internal fill-time check accommodates its own quote is its problem, not the protocol's. Kind 38173 is deliberately distinct from NIP-69's 38383 (orders): these are quotes. Activation makes the card's `discovery_pubkey` and `sig` required and adds a `relays` list to the card schema.

### Publisher behavior

Publish to all card-listed relays. Refresh every `TTL - 5s` and immediately on pair change, pair removal (final event, empty content, past expiration), or feed move > `tolerance_bps / 2`. Never quote a price older than the refresh interval.

### Consumer behavior

Subscribe `{kinds:[38173], "#d":[pair], authors:[index pubkeys]}`. Verify sig; drop pubkeys absent from the index; drop expired (±5s skew); dedupe per pubkey by `created_at`; on conflicts with the index, quote wins for pricing, index wins for trust. Price with `safety_bps` near zero. Fall back to v0 index pricing when no quote survives.

### Fill-failure report

```
kind: 8173 (regular)
tags: [["p", "<solver discovery_pubkey>"], ["e", "<quote event id>"]]
content: {
  "v": 1,
  "quote": <full signed quote event JSON>,
  "funding_txid": "<hex>",
  "offer": "<offer TLV hex>",
  "observed_until": <unix seconds>
}
```

Verifiable by anyone; wallets MAY downrank solver pubkeys accumulating verified reports. No protocol enforcement; flow-loss is the penalty.
