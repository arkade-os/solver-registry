# Arkade Solver Registry

A community-maintained registry of solver markets for Arkade Intents, in the
spirit of [token lists](https://tokenlists.org/): a public, forkable
curation that wallets subscribe to — not a gatekeeper. Solvers publish a
small JSON card describing the pairs, fees, and limits they quote; CI
reduces each network's cards into one flat, sorted index that clients fetch
from a single URL. See
[`docs/arkade-discovery-spec.md`](docs/arkade-discovery-spec.md) for the
full protocol.

## A registry, not the registry

Inclusion here is curation, not authorization. Nothing in the protocol
requires a solver to be listed anywhere: the covenant enforces every trade's
terms regardless of where the maker discovered the market, and any solver
watching the arkd stream can fill any offer. A registry only answers "which
markets should my wallet show?".

A registry is a repo layout and a workflow, not an instance — this repo is
the reference one, curated by PR review, and it is permissionlessly
forkable: the schema, reducer, and workflows carry no privileged state.
Clients are expected to treat solver registries the way wallets treat token
lists: ship with one or more defaults, let users add or remove registry
URLs, merge/deduplicate across them, and additionally let users pin
individual solver cards directly — a solver listed nowhere is still
reachable by any client that adds its card by hand. Trust anchors to the
registries you follow, not to this repo.

## Add a solver to this registry

1. Run `solver card` against your `solverd` (or hand-write one) to produce a
   card matching [`schema/card.schema.json`](schema/card.schema.json).
2. Save it as `solvers/<network>/<name>.json`, where `<network>` is
   `bitcoin`, `signet`, or `mutinynet`, and `<name>` matches the card's
   `name` field (`^[a-z0-9-]+$`).
3. Open a PR. CI validates the card and tells you if it's malformed.

Signing (`discovery_pubkey` + `sig`) is optional in v0 — a bare card is fully
valid, the PR is the authentication. See the spec for why.

## Consume the index

Human-readable overview: <https://arkade-os.github.io/solver-registry/>

| Network | Index |
|---|---|
| Bitcoin | <https://arkade-os.github.io/solver-registry/bitcoin.json> |
| Signet | <https://arkade-os.github.io/solver-registry/signet.json> |
| Mutinynet | <https://arkade-os.github.io/solver-registry/mutinynet.json> |

Each index is a flat, pre-sorted (best `fee_bps` first) list of markets for
that network, stamped with `generated_at` and the source `commit`, matching
[`schema/index.schema.json`](schema/index.schema.json). Fetch one URL per
registry you follow, merge, filter by pair, price from the market's
`price_feed`.

### Client library

[![npm](https://img.shields.io/npm/v/%40arkade-os%2Fsolver-discovery)](https://www.npmjs.com/package/@arkade-os/solver-discovery)

[`@arkade-os/solver-discovery`](packages/discovery-client/) implements the maker
flow so you don't have to: a portable, zero-dependency ESM library (browser /
Node / Expo) that fetches and merges registries, ranks markets, converts amounts
using each asset's precision, and computes the `wantAmount` — down to a one-call
`quoteOffer(market, { give: "base", giveAmount: "0.01" })`.

## Repo layout

```
solvers/bitcoin/    one card per solver, PR-managed
solvers/signet/
solvers/mutinynet/
schema/card.schema.json    what a solver PRs
schema/index.schema.json   what CI publishes
index.html                 landing page served at the Pages base URL
scripts/reduce.ts          the reducer: pnpm reduce
scripts/canonical.ts       canonical JSON + BIP340 helpers
tests/                     golden index, rejection cases, sort/determinism
packages/discovery-client/ @arkade-os/solver-discovery: the maker-flow client lib
```

## Reducer

```
pnpm install
pnpm reduce             # validate, then write <network>.json at repo root
pnpm reduce --check     # validate only, no output files (used in CI on PRs)
pnpm reduce --out=dist  # write indexes into dist/ instead of repo root
pnpm test               # golden index, rejection, sort-order, determinism tests
```

Flags: `--check` (validate without writing), `--out=<dir>` (output directory),
`--commit=<sha>` (source commit stamped into the index; defaults to `git
rev-parse HEAD`), `--generated-at=<unix-seconds>` (index timestamp; defaults
to the current clock — used by tests for deterministic output).

Each network directory validates independently: a broken card fails its own
network without blocking the others from building. The reducer always prints
a per-network, per-card validation report to stdout; when the
`GITHUB_STEP_SUMMARY` environment variable is set (as in GitHub Actions), the
same report is also appended to the job summary, so PR authors see exactly
which card failed and why without digging through logs.

## CI

- `validate.yml` runs on PRs that change `solvers/**`: schema/signature checks
  plus the reducer in `--check` mode, so a broken card can't merge. If you make
  this check required, scope that rule to solver changes; a globally required
  path-filtered workflow can block package-only PRs because GitHub skips it.
- `publish.yml` runs on pushes to `master` that change `solvers/**`:
  re-validates (never publishes on failure), then builds and deploys
  `bitcoin.json` / `signet.json` / `mutinynet.json` to GitHub Pages.

## Run your own registry

Fork this repo, replace the cards under `solvers/`, enable GitHub Pages
(source: GitHub Actions), and publish your own curation policy. The index
format is identical, so clients can follow any registry built with this
reducer by adding its Pages URL.
