# Arkade Market Discovery Protocol — v0

Status: draft. Scope: how makers discover solver markets, prices, fees, and limits for Arkade Intents (banco standing orders) — spot markets and corridor markets alike. Out of scope: the covenant, the TLV offer format, the fill path, and the RFQ message family corridor trades are negotiated with (specified separately). Those are unchanged; discovery itself is purely advisory and adds zero interactivity — spot trades stay fully non-interactive end to end, while a corridor trade's one RFQ exchange happens after discovery and outside this protocol.

## Design summary

The execution path already needs no interactivity: the maker funds a swap VTXO carrying the TLV offer, and any solver watching the arkd stream can fill it. The covenant enforces the terms and does not bind a specific filler. Discovery therefore only answers one question for the maker: what `wantAmount` for pair Y will clear right now?

v0 is a git repo format (the **registry**) plus a GitHub Action (the **reducer**). Solvers PR a small JSON card describing their markets. CI validates the cards and reduces them into one flat, sorted index per network. Clients fetch one URL per registry they follow, merge, pick a market, price from its pinned feed, concede the fee plus a safety cushion, and fund the standard offer. For a spot card: no signatures, no relays, no messages to the solver, no solver-side tooling beyond writing a JSON file. Corridor markets (below) add exactly one thing — a self-authenticating rendezvous (`discovery_pubkey` + `transports`, signed) — because their trades are negotiated per-trade rather than stream-filled.

Every market side names its **corridor** — the rail it settles on — `arkade` (the unmarked default; both sides of every spot market), `bolt11` (Lightning), or `bitcoin` (an L1 output) — as part of its **asset id**, a CAIP-19-shaped identifier `<chain-namespace>:<chain-reference>/<asset-namespace>:<asset-reference>` (e.g. `arkade:bitcoin/slip44:0` for BTC on Arkade mainnet). The chain namespace IS the corridor; there is no separate corridor field. A market's identity is simply its base and quote asset ids, `<base-asset-id> / <quote-asset-id>`, so the same asset over different rails — carrying different ids — forms different markets. See *Solver card* below for the full grammar.

Anyone can run a registry: it's a repo layout and a workflow, not an instance. Clients follow a *set* of registries (shipping with well-known defaults) and can additionally pin solver cards directly, so no repo owner is a gatekeeper or single point of failure — a solver rejected or dropped by every registry is still reachable by any client that adds its card by hand (the token-list pattern).

Trust anchors to each registry repo and its PR review, not to keys. A live-quote layer with signed events is specced as **v1, dormant** — see the appendix. For spot cards, keys stay optional until that layer activates; corridor cards already carry `discovery_pubkey`, `transports`, and `sig` today, because their rendezvous is live data a maker will actually contact (see Corridor markets).

## Solver card

One file per solver per network, `solvers/<network>/<name>.json` (networks: `bitcoin`, `signet`, `mutinynet`, `regtest` — same partitioning as arkade-os/asset-registry), submitted and updated by PR. The network lives in the path, not a top-level card field, and a solver active on several networks files one card per network. `arkade`/`bolt11`/`bitcoin`-corridor asset ids also carry this same network as their chain reference (see *Asset ids and corridors*) — a redundancy the bundled id introduced — and CI rejects a card whose id names a network other than the one it's filed under.

```json
{
  "version": 0,
  "name": "arklabs-solver",
  "discovery_pubkey": "<64-hex x-only, OPTIONAL>",
  "sig": "<128-hex schnorr, OPTIONAL>",
  "markets": [
    {
      "base_asset": { "id": "arkade:bitcoin/slip44:0", "name": "Bitcoin", "ticker": "BTC", "decimals": 8 },
      "quote_asset": { "id": "arkade:bitcoin/asset:<68-hex>", "name": "Tether USD", "ticker": "USDT", "decimals": 6 },
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
| `transports` | The v0 transport map: `{ "nostr": { "relays": ["wss://..."] } }`. Nostr is the only supported protocol key; its `relays` array is required and contains 1–8 relay URLs the solver listens on. The nostr config object stays open to future nostr-specific settings alongside `relays`. OPTIONAL for spot-only cards; REQUIRED — together with `discovery_pubkey` and `sig` — when any market has a non-arkade corridor, since they are the rendezvous makers address request-for-quote messages to and a misdirecting rendezvous must not be forgeable by the PR author alone. Relays are commodity third-party infrastructure, not solver endpoints; the solver stays outbound-only behind them. |
| `base_asset`, `quote_asset` | Per-side asset descriptor: `id`, `name`, `ticker`, `decimals` (decimal places of the atomic unit, e.g. 8 for BTC ⇒ amounts in sats; the same field the Arkade asset registry metadata carries). `id` is the canonical identity AND carries the side's corridor — see *Asset ids and corridors* below; there is no separate `pair` label and no separate `base_corridor`/`quote_corridor` field. `decimals` is for rendering amounts like `min_base_amount`; it plays no role in pricing math, which stays in atomic units. `name`/`ticker` are unverified labels the solver chose — anyone can call an asset "USDT". Clients MUST group, dedupe, and price by `id` only and MAY badge verification via the asset registry. |

### Asset ids and corridors

An asset's `id` is a CAIP-19-shaped identifier: `<chain-namespace>:<chain-reference>/<asset-namespace>:<asset-reference>`. The chain namespace is the corridor — `arkade`, `bolt11` (Lightning), `bitcoin` (an L1 output), or `eip155` (any EVM chain, keyed by numeric chain id) — and IS bundled into the id rather than carried as a separate field, so the id alone is a market side's whole leg identity: two sides with the same id are the same asset on the same rail on the same network, full stop.

| Corridor | Chain reference | Example |
|---|---|---|
| `arkade` | the Arkade network the side settles on (`bitcoin`, `signet`, `mutinynet`, `regtest` — same vocabulary as the card's path) | `arkade:bitcoin/slip44:0` (BTC on Arkade mainnet) |
| `bolt11` | same Arkade-network vocabulary | `bolt11:bitcoin/slip44:0` (BTC over Lightning) |
| `bitcoin` | same Arkade-network vocabulary | `bitcoin:bitcoin/slip44:0` (BTC onchain) |
| `eip155` | the numeric EIP-155 chain id (per CAIP-2) | `eip155:1/erc20:0x…` (an ERC-20 on Ethereum mainnet) |

The asset-namespace half of the id names WHAT settles: `slip44` is a SLIP-44-registered coin — a chain's native coin traded as a plain value transfer (`arkade:bitcoin/slip44:0` is BTC; `eip155:1/slip44:60` is ETH, since Ethereum has no address for its own coin); `asset` is an Arkade-issued asset, identified by its 68-hex-char AssetId (`arkade:bitcoin/asset:<68-hex>`) — also valid on the `bolt11`/`bitcoin` corridors, since an Arkade asset moved over Lightning or onchain (e.g. a submarine-swapped stablecoin) is a real market, not a contradiction; `erc20` is an ERC-20 contract address (`eip155:1/erc20:0x…`), valid only under `eip155`. Lowercase throughout, not EIP-55 mixed case — the id is a grouping key, and a checksum that changes the bytes would split one market into two. An erc20 reference is the TOKEN's contract address, never a swap contract's; a taker resolves the settlement contract from the corridor, not from this field.

Unlike a per-chain corridor enum, `eip155:<any chain id>` is already well-formed: adding an EVM chain needs no schema edit, because CAIP-2 chain ids are open by construction — only the small set of chain *namespaces* (`arkade`, `bolt11`, `bitcoin`, `eip155`) is a deliberate, reducer-enforced vocabulary. A rail nobody has code for still fails validation (an unrecognised namespace is simply a malformed id), so this openness costs nothing at the boundary that matters: a maker never discovers a chain no client can settle on.

The market's identity and grouping key is `<base_asset.id>/<quote_asset.id>` — CI computes this directly from the two ids, with no derived label to keep in sync. The two legs MUST differ (identical ids on both sides is a null trade), and when exactly one side's id names the arkade corridor it MUST be the base side, so equivalent markets group under one canonical key; CI enforces both. A market with neither side on the arkade corridor (e.g. `bolt11:bitcoin/slip44:0` against `bitcoin:bitcoin/slip44:0`) is permitted with no required leg order; note the consequence: the two orientations form two distinct market groups in the index, so listings only aggregate when solvers agree on orientation. If such markets see real use, a future revision may impose a canonical order for them too.
| `price_feed` | The exact URL the solver's plugin validates against at fill time. Makers MUST price from this URL, not a substitute. MUST be fetchable from browsers (CORS-permissive), otherwise browser wallets cannot price the pair. The response MUST be JSON. REQUIRED (with `price_feed_schema` and `price_decimals`) when the sides carry different assets; MUST be ABSENT on a same-asset market, whose price is identically 1 — `fee_bps` is the whole spread. CI enforces both directions of this rule. |
| `price_feed_schema` | How to read the numeric feed value from the response. v0 supports `{ "type": "json", "price_path": "<RFC 6901 JSON Pointer>" }`. Examples: Binance ticker price uses `/price`; CoinGecko simple price for `ids=bitcoin&vs_currencies=usd` uses `/bitcoin/usd`; a bare JSON number uses the empty pointer `""`. The pointer MUST resolve to a JSON number or numeric string. Clients MUST NOT infer by scanning arbitrary response bodies. |
| `price_decimals` | How to normalize the feed's value to quote-units-per-base-unit: the feed value divided by `10^price_decimals` MUST be the price in quote-atomic-units per base-atomic-unit. Mirrors the solver Pair config; the feed is always advertised in base/quote terms, never inverted. Independent of the assets' `decimals`: for a feed quoted in display units (quote-display per base-display, e.g. typical exchange tickers) this works out to `base_asset.decimals − quote_asset.decimals`, but for a feed already in atomic terms it does not — derive it from the feed's actual denomination, never from asset `decimals` alone. |
| `fee_bps` | The solver's spread: the promise is that an offer priced at least `fee_bps` (plus a reasonable safety cushion) inside fair value will fill. The solver's fill-time tolerance check is internal and MUST be wide enough to honor this; a solver whose published fee doesn't fill loses flow. |
| `min_base_amount`, `max_base_amount`, `min_quote_amount`, `max_quote_amount` | Per-side trade size bounds as **decimal strings** of that side's atomic units (sats when the side is BTC), canonical form `^(0\|[1-9][0-9]{0,29})$` — no sign, no leading zeros. Strings keep amounts exact: JSON numbers round past 2^53, which cannot hold even one whole token of an 18-decimal asset, and a single canonical encoding keeps card signatures stable. All four are REQUIRED. `max = "0"` disables the side — the solver does not pay it out (solve it) and makers MUST NOT take the direction that receives it; `min` MUST then also be `"0"`. An enabled side has `1 <= min <= max` (compared as integers), and at least one side MUST be enabled. The bound applies to the amount the maker receives (the solver pays) on that side: a solver that zeroes the base bounds only serves makers depositing base to receive quote; enabling both sides serves both directions. |

Keys and signatures are future-proofing for spot cards, not a requirement: requiring signing tooling just to list a spot market is friction without a payoff, so a bare spot card with neither field is fully valid and the PR is the authentication. Solvers that set them up now get continuity — the same key later signs v1 quotes, and card updates become verifiable independent of who opens the PR. (Corridor cards are the exception: there the key is load-bearing today, see below.) No `updated_at`: hand-maintained timestamps rot; freshness is stamped programmatically in the index. No URLs pointing at solver or Arkade infrastructure (`price_feed` and `transports` excepted — the former is the pricing oracle, the latter commodity relay endpoints).

## Corridor markets

A corridor market has at least one side whose asset id names a non-arkade corridor — typically an Arkade balance trading against a Lightning payment (`bolt11`) or an L1 output (`bitcoin`), though both sides may be off-rail (e.g. a `bolt11:bitcoin/slip44:0` / `bitcoin:bitcoin/slip44:0` submarine-swap market). Everything in this section — the rendezvous requirements, the feed rules, leg-pair grouping — keys off "has a non-arkade side" and applies to rail-to-rail markets identically. Discovery works identically — the card advertises the two asset ids, `fee_bps`, and per-side limits, and the reducer ranks it in the same index — but three things differ structurally from a spot market:

**Pricing.** The interesting corridor pairs are same-asset (BTC against BTC over another rail), where the price is identically 1 and `fee_bps` is the entire cost of trading. Such markets carry no feed fields at all; the executable amounts arrive in the solver's quote. A cross-asset corridor market (say Lightning BTC against an Arkade stablecoin) still carries a feed like any spot pair.

**Negotiation instead of stream-filling.** A spot offer is funded blind and filled by whoever watches the arkd stream; nothing needs to reach the solver. A corridor trade starts with a request-for-quote: the maker addresses the solver's `discovery_pubkey` over the card's `transports` (specifically the `"nostr"` entries), receives a quote binding the terms (amounts, contract parameters, expiry), derives the contracts locally, and funds. There is no accept message — **funding the derived address is acceptance** — so after the quote, filling is non-interactive again: the maker may go offline and the contracts enforce the terms. The registry's job ends at the rendezvous: pubkey + transports.

The RFQ message family is specified separately, in `arkade-os/lightning-swap-service` `docs/rfq-protocol.md`, and is **implemented and deployed** — unlike the v1 appendix below, which remains dormant. It claims three provisional nostr kinds, listed here only so this document's kind numbering does not collide with them:

| kind | | |
| --- | --- | --- |
| `24859` | directed RFQ traffic | **ephemeral**; NIP-44-sealed, `p`-tagged to the recipient; carries the whole request/quote/refusal/status family |
| `24860` | open-RFQ broadcast | **ephemeral**; plaintext, `t`-tagged with the canonical market key (`<base-asset-id>/<quote-asset-id>`) |
| `38859` | solver advertisement | **addressable** — one current version per solver; `d` tag `"rfq1"`, unencrypted and **indicative only** — never binding, and never a substitute for a registry card (see the trust note below) |

The two negotiation kinds moved out of NIP-01's regular range into the ephemeral one (20000–29999): `4859`/`4860` before, `24859`/`24860` now. The reason bears directly on this document's own kind choices — an `rfq_open` is plaintext by design, so while it sat in a retained range every broadcast was a permanent public record of trade intent, pair and size. A conforming relay retains neither negotiation kind now. The advertisement stays addressable, which is already the right semantics for it: the relay keeps the current version and discards the rest.

The `t` tag on kind 24860 is the *same* canonical leg-pair key this document defines for the v1 appendix's `d` tag — the two full asset ids, corridor and all, base leg first — and for the same reason: both sides must derive it identically or the subscription silently matches nothing. One derivation, two layers; if either changes, both change.

The kind-38859 ad does not compete with a card. The RFQ protocol defers to the registry for trust precisely because a card is git-reviewed and BIP340-signed while an ad is self-asserted, so an ad MAY advertise liveness but MUST NOT be the basis for deciding whom to trade with.

**The rendezvous must be self-authenticating.** For a spot card a wrong `discovery_pubkey` is inert. For a corridor card it decides whom makers talk to, so `discovery_pubkey`, `sig`, and `transports` are all REQUIRED on any card with a corridor market, and CI verifies the signature. A wrong rendezvous cannot lose funds — the maker derives and verifies every contract locally before funding, exactly as with spot offers — but it can misdirect makers into silence, which is why it must carry the solver's own signature rather than just the PR author's word. This pulls the v1 appendix's key material forward for corridor cards; the live-quote layer itself stays dormant. (The signature requirement gates *listing*: a user-pinned local corridor card needs only `discovery_pubkey` and `transports` — pinning is the user's own trust decision, and clients carry no signature-verification code.)

Directionality maps onto the existing per-side bounds with no new fields. The bound still applies to the side the solver pays out: a solver quoting Arkade BTC against Lightning BTC with the quote side enabled pays out Lightning — it serves makers sending an Arkade balance out over Lightning. Enabling the base side serves the opposite direction (maker receives the Arkade side); `max = "0"` disables a direction, as ever.

Canonical form, CI-enforced: the two legs' ids must differ; when exactly one side's id names the arkade corridor it is the base side (so `arkade:bitcoin/slip44:0` base / `bolt11:bitcoin/slip44:0` quote exists and the reverse does not, and equivalent markets group under one key).

```json
{
  "version": 0,
  "name": "arklabs-solver",
  "discovery_pubkey": "<64-hex x-only, REQUIRED here>",
  "transports": { "nostr": { "relays": ["wss://relay.example.com"] } },
  "markets": [
    {
      "base_asset": { "id": "arkade:bitcoin/slip44:0", "name": "Bitcoin", "ticker": "BTC", "decimals": 8 },
      "quote_asset": { "id": "bolt11:bitcoin/slip44:0", "name": "Bitcoin", "ticker": "BTC", "decimals": 8 },
      "fee_bps": 30,
      "min_base_amount": "1000",
      "max_base_amount": "5000000",
      "min_quote_amount": "1000",
      "max_quote_amount": "5000000"
    }
  ],
  "sig": "<128-hex schnorr, REQUIRED here>"
}
```

**Rollout sequencing.** Clients built before this section (`@arkade-os/solver-discovery` 0.1.x) fetch a market's feed unconditionally and throw on a corridor entry's absent `price_feed`. A registry MUST NOT merge its first corridor card until the clients it serves have upgraded to a corridor-aware release (0.2.0+); until then a corridor card is not backward-compatible data, it is a client crash. Spot cards are unaffected either way.

One consequence worth naming: corridor markets close v0's liveness gap for their own trades. A spot maker funds blind — nothing can be probed before funding. A corridor maker gets a quote (or a structured refusal, or silence) before committing anything, so a dead solver costs a timeout instead of a cancel transaction.

### EVM corridors — CAIP-2 chain ids, and card version 1

An EVM corridor trades an Arkade balance against an ERC-20 token, and needs **no new market fields**. The shape already fits: `base_asset`/`quote_asset` carry `decimals`, amounts are atomic-unit decimal strings, and a token-against-BTC market is cross-asset so the existing rule already requires `price_feed`, `price_feed_schema` and `price_decimals`. What it needed was a rail the schema would accept — see *Asset ids and corridors* above for the shape it landed on: `eip155:<chain-id>/erc20:<address>` or `eip155:<chain-id>/slip44:<coin-type>`.

**Chains are addressed per chain — `eip155:<chain-id>`, not `evm`.** Two independent reasons, either sufficient:

- **An ERC-20 address is unique only within one chain.** Canonical identity is the whole asset id, so a chain-blind rail would give USDC-on-Ethereum and USDC-on-some-L2 the *same* id and collapse two markets the reducer must keep apart. Deterministic deployment makes this worse than theoretical: one address can name different tokens on different chains.
- **"EVM-compatible" is not "interchangeable".** Gas mechanics, fee markets, finality and reorg behaviour differ between chains. A blanket `evm` rail would advertise a capability no solver can back — a maker reading it would reasonably infer that any EVM chain works.

Earlier drafts of this document rejected CAIP-2 chain ids for exactly this purpose, because a colon-bearing rail fought the `pair` label's own `<corridor>:<ticker>` separator. Bundling the corridor into the asset id — and dropping the `pair` label entirely, since identity was always the ids, never the label — removes that conflict: `eip155:1` is now just the leading segment of an id, nothing splits on it. This is also why adding an EVM chain needs no schema edit any more: unlike the old per-chain corridor enum, `eip155:<any chain id>` is already well-formed, and the small, deliberately curated vocabulary lives one level up, at the chain-*namespace* set (`arkade`, `bolt11`, `bitcoin`, `eip155`) — a rail nobody has code for still fails validation, just as an unrecognised namespace rather than an unrecognised enum value.

**The chain's own coin is a SLIP-44 id, not an address**, because it has none — `{ "id": "eip155:1/slip44:60", "ticker": "ETH", "decimals": 18 }`. This mirrors how `arkade:bitcoin/slip44:0` already names Bitcoin without an address. Chain-qualified by construction, since it's part of the same id as the chain reference: the same token stays one market and each chain's own coin stays its own.

**This is also why the id does not separately name a token standard.** An id like `eip155:1/erc20-swap:0x…` looks tempting — a native coin and a token really are settled by different contracts on every EVM chain (Boltz, for instance, ships `EtherSwap` and `ERC20Swap` as separate deployments). But that distinction is already carried, unambiguously, by the asset-namespace half of the id: `slip44` means the chain's coin, `erc20` means a contract at that address. Encoding it a second time would put the same fact in two places that can disagree.

**Limits worth stating rather than discovering.** The `id` shape identifies an asset by *one* reference, which covers a native coin and any single-address fungible token — ERC-20 and the standards that are ERC-20-compatible in the transfer path. It does **not** express an asset that needs a compound identifier, ERC-1155 being the live example: a 1155 asset is `(contract address, token id)`, and no combination of the current fields names one. A registry MUST NOT list such a market by putting the token id somewhere else; adding a new asset namespace is the correct route, and would be a further version bump under the same rule as above.

**Card version.** A card whose markets use a corridor introduced after version 0 MUST declare `"version": 1`, and a consumer that understands only version 0 MUST reject such a card whole rather than keep the markets it recognises and drop the rest.

This is about interpretation, not encoding. The canonical form and the signature are unchanged by a new corridor, so a version-0 verifier would compute a matching digest and correctly conclude the card is authentic — and would then be holding a market on a rail it cannot settle. Today such a consumer happens to degrade safely, because an unrecognised chain namespace fails the client's own asset-id pattern and the market is dropped; but that is a property of the current client rather than a promise of the format, and it is per-market rather than per-card. The version makes it the format's promise.

The **rollout sequencing** rule above applies unchanged, for the same reason it applied to corridor markets: a registry MUST NOT merge its first version-1 card until the clients it serves ship a release that understands version 1.

## The reducer (GitHub Action)

On every merge to the default branch, CI, independently per network directory:

1. Validates every card against the JSON schema (schema lives in the repo); rejects duplicate `name`s, malformed asset ids, per-side `min > max`, a zero `min` on an enabled side, both sides disabled, unknown `version`, identical legs, a non-base arkade side when only one side is arkade, feed fields on a same-asset market, a cross-asset market missing them, and a corridor market on a card lacking `discovery_pubkey`/`sig`/`transports`. Where a card carries `sig`, verifies it against `discovery_pubkey` and rejects on failure.
2. Flattens the network's cards into one market list, each entry carrying its solver's `name` (and `discovery_pubkey`/`transports` when present; `sig` stays in the card, it is not propagated).
3. Groups by the leg pair (`base_asset.id`, `quote_asset.id`) — never by the ticker; within a group, sorts ascending by `fee_bps` (best expected execution first).
4. Emits one index per network — `bitcoin.json`, `signet.json`, `mutinynet.json`, `regtest.json` — each stamped with its `network`, `generated_at` (unix seconds, set by CI, never by hand), and the source commit hash.
5. Publishes via GitHub Pages / raw URL. A broken card in one network must not block publishing the others.

```json
{
  "version": 0,
  "network": "bitcoin",
  "generated_at": 1783958400,
  "commit": "<git sha>",
  "markets": [
    {
      "solver": "arklabs-solver",
      "discovery_pubkey": "<optional>",
      "base_asset": { "id": "arkade:bitcoin/slip44:0", "name": "Bitcoin", "ticker": "BTC", "decimals": 8 },
      "quote_asset": { "id": "arkade:bitcoin/asset:<68-hex>", "name": "Tether USD", "ticker": "USDT", "decimals": 6 },
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
2. Merge: union of all markets across followed registries plus local cards, tagged with their source. Drop byte-identical duplicates (the same solver listed in two registries); otherwise entries are distinct per source — `name` is only unique within a registry. Re-rank the merged set per leg pair (`base_asset.id`/`quote_asset.id`) ascending by `fee_bps`, source order as tiebreak; a side's ticker is display only and never a grouping key — grouping by ticker, or by an asset id with its corridor stripped, would collapse markets on different rails. Filter by leg pair, by receive-side solvability (only markets whose receive side is enabled — `max > 0` — qualify; if no market in the merged set solves that side, the direction MUST NOT be offered), and by size against the receive side's bounds. The ranking is a static proxy — the actual execution price still comes from the feed (spot) or the solver's quote (corridor).
3. Local cards: a client MUST let its user add solver cards directly (a URL to a raw card, or pasted JSON), validated against the same card schema, scoped to a network by the user. Local cards participate in the merge like any registry entry, marked as user-added in any UI.
4. Fetch the chosen market's `price_feed`, parse the JSON response, read the scalar selected by `price_feed_schema.price_path`, then derive `P` in quote-units-per-base-unit via `price_decimals`. A same-asset corridor market skips this step entirely: `P = 1` exactly, and any pre-quote estimate is `fee_bps` (plus cushion) off 1:1.
5. Spot market: compute `wantAmount` (below), then the existing flow: `createOffer` → fund the address with the TLV extension. Corridor market: send a request-for-quote to the market's `discovery_pubkey` over its `transports`, verify the quote's terms and locally-derived contract addresses, then fund — per the RFQ protocol (`arkade-os/lightning-swap-service` `docs/rfq-protocol.md`), whose directed traffic is nostr kind 24859. Funding is the acceptance; there is no separate accept step.

There is no liveness signal in v0 for spot markets: those solvers are not publicly reachable, so nothing can be probed before funding — `generated_at` and local fill history are the only heuristics, and the cost of funding into a dead solver is one cancel transaction. Corridor markets are probed by construction: the quote (or its absence) precedes any funding.

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

**Why are signatures optional rather than required or absent?** Required would mean every solver needs keygen and signing tooling before it can list, for no v0 payoff — the client's decision doesn't depend on solver identity, since the covenant protects the funds either way, and the PR process already gates listing. Absent would break continuity with v1, where the same key must sign quotes. Optional costs nothing: bare cards list freely, signed cards get CI verification and a stable identity today. Corridor cards are the exception where the payoff exists now — the pubkey is whom makers talk to — so there, signing is required.

**Why per-side corridors instead of directional pair entries?** A corridor trade is directional (send vs receive), but a market is not: the solver's real constraint is still inventory on the side it pays out, which the existing per-side bounds already express. One bidirectional entry with corridor-carrying ids reuses `max = "0"` as the direction switch, adds zero new amount fields, and keeps spot and corridor markets structurally identical for ranking and merging.

**Why bundle the corridor into the asset id instead of a separate `base_corridor`/`quote_corridor` field?** The two were always describing one thing — which leg a side is — and keeping them apart meant every consumer (the reducer's grouping key, the client's `marketLegKey`, this document's own leg-pair key) had to concatenate them back together anyway, and get the concatenation right the same way every time. CAIP-19 already has a standard grammar for exactly this composite — chain plus asset in one string — so adopting it removes a can't-disagree invariant (`quote_corridor` matching what the id actually settles on) rather than just relocating it, and, as a consequence, opens the door to real per-chain CAIP-2 ids instead of a hand-maintained per-chain enum for `eip155`.

**Why must the arkade side be base?** Canonical ordering. Without it, one solver lists Arkade BTC against Lightning BTC and another lists the reverse, the leg-pair keys differ, and the same economic market splits into two groups that rank independently. Any fixed rule works; anchoring on the arkade side reads naturally ("the Arkade balance priced in the other rail") and matches how the RFQ pair strings are written.

**Why do same-asset markets forbid feed fields instead of ignoring them?** Determinism and honesty. A feed on a 1:1 pair can only mislead — there is no market price to read — and permitting a decorative one would make two byte-different encodings of the same market, breaking dedupe and signature stability. "Same-asset" compares the asset-namespace half of the id only (see *Asset ids and corridors*), so an Arkade BTC balance against a Lightning BTC payment qualifies even though their full ids differ.

**Why is the solver's fill tolerance not in the card?** It's an internal enforcement knob, not a promise to the client. The client-meaningful number is `fee_bps`: concede that plus a cushion and the offer should fill. Publishing tolerance would leak an implementation parameter, drag derived rules into client code, and tempt clients to price against the band's edge — exactly the offers most likely to sit unfilled under feed divergence.

**Why `fee_bps` as the sort key?** It's the only static, client-meaningful cost of trading against a market. Feeds move; this doesn't, so it's the only honest ranking a static index can make.

**Why JSON Pointer for price feeds?** Existing price APIs are not uniform: Binance exposes a top-level `price`, while CoinGecko's simple endpoint nests by coin and currency. Scanning a response for "the only number" breaks as soon as the provider adds metadata or multiple currencies. JSON Pointer is an IETF-standard way to select exactly one value from a JSON document; JSONPath is more expressive but can select sets of values, which is unnecessary for a price scalar and harder to validate consistently across runtimes.

**Why no `ark_server` or any solver URL?** URLs couple the registry to infrastructure that can be seized, moved, or rotated, and clients have no reason to contact it.

**Why per-side limits?** Two reasons. Denomination: `min_sats` breaks the moment neither side of a pair is BTC, while each side's own atomic units are well-defined for every pair (BTC sides degrade to sats). Directionality: a solver's real constraint is inventory on the side it pays out, and the two sides' inventories are independent — a solver flush with the quote asset but dry on base can serve makers wanting quote and nobody else. Per-side bounds let a solver advertise exactly the direction(s) it can fill, instead of one base-side bound that pretends both directions are always available. `max = 0` *is* the disable switch — every card carries the same four fields, and there is no separate solvability flag to drift out of sync with the bounds.

**Why not iroh or any p2p transport?** A market card is <1KB, read-only, best-effort. Direct connections and gossip solve none of that and reintroduce interactivity and bootstrap infrastructure.

---

## Appendix: v1 — signed live quotes over nostr (dormant)

> **Not to be confused with the RFQ protocol.** RFQ (kinds 24859/24860/38859, see *Corridor markets*) is live and deployed; it is *directed negotiation* for corridor markets. This appendix is *broadcast pricing* for spot markets on kind 38173, and nothing implements it. The two share the card's key material and the canonical leg-pair key derivation, and nothing else.

### Why this layer exists

Three things static-registry pricing cannot provide:

**Liveness.** v0 has no liveness signal for spot markets: solvers sit behind NAT with no public endpoint, so nothing can be probed before funding. A fresh signed quote proves the solver is awake and quoting *now*, and it works structurally under this constraint — the solver publishes outbound to relays, needing no inbound reachability.

This was the strongest single argument for activating v1, and corridor markets have since taken it off the table for themselves — twice over. Their quote *is* the liveness probe (a dead solver costs a timeout, not a cancel tx), and the RFQ family's kind-38859 ad already broadcasts indicative liveness outbound to relays, which is structurally the mechanism proposed here. What remains unserved is the case this layer was actually designed for: **spot** markets, which are funded blind and have neither. Activating v1 is now a spot-market decision, not a general one.

**Spread.** Maker and solver observe the feed at different times, so the maker leaves `safety_bps` on the table every trade. A quote signed by the solver — "price Z, valid until T" — removes the ambiguity and lets the cushion shrink toward zero. Matters when solvers compete fees down toward ~10bps; at wide spreads it buys little.

**Accountability.** A signed quote is evidence. Registry-only, a maker cannot prove what the price was when it funded. With signed quotes, a maker holding quote + funding txid + no fill can publish a verifiable report; anyone can check the offer was inside the quote's envelope during its validity.

This is also where keys and signatures enter the protocol for spot markets — as the thing that makes quotes attributable — and why v0 makes them optional there: the identity becomes meaningful only when there is a live statement to sign. Corridor markets already pulled `discovery_pubkey`, `sig`, and `transports` forward (their rendezvous is a live commitment today, exercised by deployed RFQ traffic); activating this layer changes nothing for them structurally — the same key that anchors the RFQ rendezvous, and signs its kind-38859 ad, would sign the quote events. Why nostr specifically: addressable events give latest-quote-per-(solver, pair) retention for free, NIP-40 expiration gives the validity window, relays already exist, and `discovery_pubkey` is nostr-compatible. No infrastructure to run, ~200 lines per side.

### Quote event

One per (solver, pair):

```
kind: 38173
pubkey: <discovery_pubkey>
tags:
  ["d", "<base-asset-id>/<quote-asset-id>"]   // full CAIP-19 ids, not tickers — the d tag is an identity, labels collide
  ["expiration", "<created_at + 30>"]        // NIP-40
content: {
  "v": 1,
  "pair": "<base-asset-id>/<quote-asset-id>",
  "price": "1.00020000",
  "fee_bps": 30,
  "min_base_amount": "1000",
  "max_base_amount": "5000000",
  "min_quote_amount": "1000000",
  "max_quote_amount": "5000000000",
  "feed": "https://feed.example.com/price?pair=..."
}
```

The `d` tag and `content.pair` are the **canonical leg-pair key** — the two sides' `base_asset.id`/`quote_asset.id`, exactly as they appear on the card, joined with `/` — computed identically to the reducer's own grouping key (see *Asset ids and corridors*). Since the corridor is bundled into each id, there is nothing left to resolve or default: both producers and subscribers derive this key by simple string concatenation, and both MUST use it — never a ticker-based label — or subscriptions silently miss quotes published under a different representation.

`price` is a decimal string in quote-units-per-base-unit, already normalized and net of nothing — the maker still concedes `fee_bps` from it. The commitment: an offer funded before `expiration`, within limits, priced at or inside `price` less `fee_bps`, will be filled. How the solver's internal fill-time check accommodates its own quote is its problem, not the protocol's. Kind 38173 is deliberately distinct from NIP-69's 38383 (orders): these are quotes. Activation makes the card's `discovery_pubkey`, `sig`, and `transports` required for every card (corridor cards already require all three today).

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
