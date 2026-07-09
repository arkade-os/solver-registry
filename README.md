# Solver Registry

Arkade Market Discovery Protocol v0: a registry of solver markets for Arkade
Intents. Solvers PR a small JSON card describing the pairs, fees, and limits
they quote; CI reduces every network's cards into one flat, sorted index that
wallets fetch from a single URL. No server-side code, no signatures required,
no messages to the solver — the repo's PR review is the trust anchor. See
[`docs/arkade-discovery-spec.md`](docs/arkade-discovery-spec.md) for the full
protocol.

## List your solver

1. Run `solver card` against your `solverd` (or hand-write one) to produce a
   card matching [`schema/card.schema.json`](schema/card.schema.json).
2. Save it as `solvers/<network>/<name>.json`, where `<network>` is
   `mainnet`, `signet`, or `mutinynet`, and `<name>` matches the card's
   `name` field (`^[a-z0-9-]+$`).
3. Open a PR. CI validates the card and tells you if it's malformed.

Signing (`discovery_pubkey` + `sig`) is optional in v0 — a bare card is fully
valid, the PR is the authentication. See the spec for why.

## Fetch the index

| Network | Index |
|---|---|
| Mainnet | `https://<pages-url>/mainnet.json` |
| Signet | `https://<pages-url>/signet.json` |
| Mutinynet | `https://<pages-url>/mutinynet.json` |

Each index is a flat, pre-sorted (best `fee_bps` first) list of markets for
that network, stamped with `generated_at` and the source `commit`. Fetch one
URL, filter by pair, price from the market's `price_feed`.

## Repo layout

```
solvers/mainnet/    one card per solver, PR-managed
solvers/signet/
solvers/mutinynet/
schema/card.schema.json    what a solver PRs
schema/index.schema.json   what CI publishes
scripts/reduce.ts          the reducer: node scripts/reduce.ts
scripts/canonical.ts       canonical JSON + BIP340 helpers
tests/                     golden index, rejection cases, sort/determinism
```

## Reducer

```
node scripts/reduce.ts            # validate, then write <network>.json at repo root
node scripts/reduce.ts --check    # validate only, no output files (used in CI on PRs)
node scripts/reduce.ts --out=dist # write indexes into dist/ instead of repo root
```

Each network directory validates independently: a broken card fails its own
network without blocking the others from building. `npm test` runs the golden
index, rejection, sort-order, and determinism tests.

## CI

- `validate.yml` runs on every PR: schema/signature checks plus the reducer
  in `--check` mode, so a broken card can't merge. Configure branch
  protection on `master` to require this check.
- `publish.yml` runs on push to `master`: re-validates (never publishes on
  failure), then builds and deploys `mainnet.json` / `signet.json` /
  `mutinynet.json` to GitHub Pages.
