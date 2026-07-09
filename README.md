# Arkade Solver List

A community-maintained list of solver markets for Arkade Intents, in the
spirit of [token lists](https://tokenlists.org/): a public, forkable JSON
list that wallets can subscribe to — not a gatekeeper. Solvers publish a
small JSON card describing the pairs, fees, and limits they quote; CI
reduces each network's cards into one flat, sorted index that clients fetch
from a single URL. See
[`docs/arkade-discovery-spec.md`](docs/arkade-discovery-spec.md) for the
full protocol.

## Lists, not permission

Inclusion here is curation, not authorization. Nothing in the protocol
requires a solver to be listed anywhere: the covenant enforces every trade's
terms regardless of where the maker discovered the market, and any solver
watching the arkd stream can fill any offer. A list only answers "which
markets should my wallet show?".

This repo is one such list — the reference one, curated by PR review. It is
fully forkable: the schema, reducer, and workflows carry no privileged
state, so anyone can run their own list with their own curation policy.
Clients are expected to treat solver lists the way wallets treat token
lists: ship with one or more default lists, let users add or remove list
URLs, and merge/deduplicate across them. Trust anchors to the list you
subscribe to, not to this repo.

## Add a solver to this list

1. Run `solver card` against your `solverd` (or hand-write one) to produce a
   card matching [`schema/card.schema.json`](schema/card.schema.json).
2. Save it as `solvers/<network>/<name>.json`, where `<network>` is
   `mainnet`, `signet`, or `mutinynet`, and `<name>` matches the card's
   `name` field (`^[a-z0-9-]+$`).
3. Open a PR. CI validates the card and tells you if it's malformed.

Signing (`discovery_pubkey` + `sig`) is optional in v0 — a bare card is fully
valid, the PR is the authentication. See the spec for why.

## Consume this list

| Network | Index |
|---|---|
| Mainnet | `https://<pages-url>/mainnet.json` |
| Signet | `https://<pages-url>/signet.json` |
| Mutinynet | `https://<pages-url>/mutinynet.json` |

Each index is a flat, pre-sorted (best `fee_bps` first) list of markets for
that network, stamped with `generated_at` and the source `commit`, matching
[`schema/index.schema.json`](schema/index.schema.json). Fetch one URL,
filter by pair, price from the market's `price_feed`.

## Repo layout

```
solvers/mainnet/    one card per solver, PR-managed
solvers/signet/
solvers/mutinynet/
schema/card.schema.json    what a solver PRs
schema/index.schema.json   what CI publishes
scripts/reduce.ts          the reducer: pnpm reduce
scripts/canonical.ts       canonical JSON + BIP340 helpers
tests/                     golden index, rejection cases, sort/determinism
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

- `validate.yml` runs on every PR: schema/signature checks plus the reducer
  in `--check` mode, so a broken card can't merge. Configure branch
  protection on `master` to require this check.
- `publish.yml` runs on push to `master`: re-validates (never publishes on
  failure), then builds and deploys `mainnet.json` / `signet.json` /
  `mutinynet.json` to GitHub Pages.

## Run your own list

Fork this repo, replace the cards under `solvers/`, enable GitHub Pages
(source: GitHub Actions), and publish your own curation policy. The index
format is identical, so clients can subscribe to any list built with this
reducer by adding its Pages URL.
