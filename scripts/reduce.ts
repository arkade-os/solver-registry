// Arkade discovery registry reducer.
// Validates solver cards per network and flattens them into one sorted index per network.
// Runnable standalone: `node --experimental-strip-types scripts/reduce.ts`
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import cardSchema from "../schema/card.schema.json" with { type: "json" };
import { verifyCardSig } from "./canonical.ts";

export const NETWORKS = ["bitcoin", "signet", "mutinynet"] as const;
export type Network = (typeof NETWORKS)[number];

export interface AssetInfo {
  id: string;
  name: string;
  ticker: string;
  precision: number;
}

export interface PriceFeedSchema {
  type: "json";
  price_path: string;
}

export interface Market {
  pair: string;
  base_asset: AssetInfo;
  quote_asset: AssetInfo;
  price_feed: string;
  price_feed_schema: PriceFeedSchema;
  price_decimals: number;
  fee_bps: number;
  // Per-side size bounds, each side declared as a min/max pair (or not at all).
  // A declared side is one the solver can pay out; at least one side is present.
  min_base_amount?: number;
  max_base_amount?: number;
  min_quote_amount?: number;
  max_quote_amount?: number;
}

const LIMIT_SIDES = [
  ["min_base_amount", "max_base_amount"],
  ["min_quote_amount", "max_quote_amount"],
] as const;

export interface Card {
  version: 0;
  name: string;
  discovery_pubkey?: string;
  sig?: string;
  markets: Market[];
}

export interface IndexMarket extends Market {
  solver: string;
  discovery_pubkey?: string;
}

export interface NetworkIndex {
  version: 0;
  network: Network;
  generated_at: number;
  commit: string;
  markets: IndexMarket[];
}

export interface CardError {
  file: string;
  messages: string[];
}

export interface NetworkResult {
  network: Network;
  ok: boolean;
  errors: CardError[];
  index?: NetworkIndex;
}

// strictRequired would reject the market schema's anyOf branches, which require
// limit properties declared on the parent schema rather than in the branch.
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validateCardSchema = ajv.compile(cardSchema);

function loadCardFiles(dir: string): Array<{ file: string; raw: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, raw: readFileSync(join(dir, file), "utf8") }));
}

export function reduceNetwork(
  solversDir: string,
  network: Network,
  meta: { generatedAt: number; commit: string },
): NetworkResult {
  const dir = join(solversDir, network);
  const files = loadCardFiles(dir);
  const errors: CardError[] = [];
  const cards: Array<{ file: string; card: Card }> = [];
  const seenNames = new Map<string, string>();

  for (const { file, raw } of files) {
    const messages: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push({ file, messages: [`invalid JSON: ${(e as Error).message}`] });
      continue;
    }

    if (!validateCardSchema(parsed)) {
      for (const err of validateCardSchema.errors ?? []) {
        messages.push(`${err.instancePath || "/"} ${err.message}`);
      }
    }

    const card = parsed as Card;
    const expectedName = basename(file, ".json");

    if (messages.length === 0) {
      if (card.name !== expectedName) {
        messages.push(
          `name "${card.name}" does not match filename "${file}"`,
        );
      }
      for (const [i, market] of card.markets.entries()) {
        for (const [minKey, maxKey] of LIMIT_SIDES) {
          const min = market[minKey];
          const max = market[maxKey];
          if (min !== undefined && max !== undefined && min > max) {
            messages.push(`markets[${i}]: ${minKey} (${min}) > ${maxKey} (${max})`);
          }
        }
        const expectedPair = `${market.base_asset.ticker}/${market.quote_asset.ticker}`;
        if (market.pair !== expectedPair) {
          messages.push(
            `markets[${i}]: pair "${market.pair}" does not match asset tickers "${expectedPair}"`,
          );
        }
      }
      if (card.sig) {
        if (!verifyCardSig(card)) {
          messages.push("sig does not verify against discovery_pubkey");
        }
      }
      if (seenNames.has(card.name)) {
        messages.push(
          `duplicate name "${card.name}" (also used by ${seenNames.get(card.name)})`,
        );
      } else {
        seenNames.set(card.name, file);
      }
    }

    if (messages.length > 0) {
      errors.push({ file, messages });
    } else {
      cards.push({ file, card });
    }
  }

  if (errors.length > 0) {
    return { network, ok: false, errors };
  }

  const markets: IndexMarket[] = [];
  for (const { card } of cards) {
    for (const market of card.markets) {
      const entry: IndexMarket = {
        ...market,
        solver: card.name,
      };
      if (card.discovery_pubkey) entry.discovery_pubkey = card.discovery_pubkey;
      markets.push(entry);
    }
  }

  // Group by canonical asset ids (tickers are display-only and not unique),
  // then best expected execution first, solver name for determinism.
  markets.sort((a, b) => {
    const idPairA = `${a.base_asset.id}/${a.quote_asset.id}`;
    const idPairB = `${b.base_asset.id}/${b.quote_asset.id}`;
    if (idPairA !== idPairB) return idPairA < idPairB ? -1 : 1;
    if (a.fee_bps !== b.fee_bps) return a.fee_bps - b.fee_bps;
    return a.solver < b.solver ? -1 : a.solver > b.solver ? 1 : 0;
  });

  return {
    network,
    ok: true,
    errors: [],
    index: {
      version: 0,
      network,
      generated_at: meta.generatedAt,
      commit: meta.commit,
      markets,
    },
  };
}

export function reduceAll(
  solversDir: string,
  meta: { generatedAt: number; commit: string },
): NetworkResult[] {
  return NETWORKS.map((network) => reduceNetwork(solversDir, network, meta));
}

// Directories under solvers/ that aren't a known network are typos or misplaced
// cards: they'd otherwise be silently skipped by reduceAll, so surface them.
export function findUnknownNetworkDirs(solversDir: string): string[] {
  if (!existsSync(solversDir)) return [];
  return readdirSync(solversDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !(NETWORKS as readonly string[]).includes(name))
    .sort();
}

function resolveCommit(explicit: string | undefined, repoRoot: string): string {
  if (explicit) return explicit;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "0".repeat(40);
  }
}

function formatReport(results: NetworkResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    if (result.ok) {
      lines.push(`${result.network}: OK (${result.index!.markets.length} markets)`);
    } else {
      lines.push(`${result.network}: FAILED`);
      for (const err of result.errors) {
        lines.push(`  ${err.file}:`);
        for (const message of err.messages) lines.push(`    - ${message}`);
      }
    }
  }
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const outDirArg = args.find((a) => a.startsWith("--out="));
  const commitArg = args.find((a) => a.startsWith("--commit="));
  const generatedAtArg = args.find((a) => a.startsWith("--generated-at="));

  const scriptDir = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = join(scriptDir, "..");
  const solversDir = join(repoRoot, "solvers");
  const outDir = outDirArg ? outDirArg.slice("--out=".length) : repoRoot;

  const generatedAt = generatedAtArg
    ? Number(generatedAtArg.slice("--generated-at=".length))
    : Math.floor(Date.now() / 1000);
  const commit = resolveCommit(
    commitArg ? commitArg.slice("--commit=".length) : undefined,
    repoRoot,
  );

  const results = reduceAll(solversDir, { generatedAt, commit });
  const unknownDirs = findUnknownNetworkDirs(solversDir);
  let report = formatReport(results);
  if (unknownDirs.length > 0) {
    report += `\nunknown network directories (expected one of ${NETWORKS.join(", ")}): ${unknownDirs.join(", ")}`;
  }
  console.log(report);

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Registry reduce report\n\n\`\`\`\n${report}\n\`\`\`\n`,
      { flag: "a" },
    );
  }

  if (!check) {
    for (const result of results) {
      if (result.ok) {
        const outPath = join(outDir, `${result.network}.json`);
        writeFileSync(outPath, JSON.stringify(result.index, null, 2) + "\n");
        console.log(`wrote ${outPath}`);
      }
    }
  }

  const anyFailed = results.some((r) => !r.ok) || unknownDirs.length > 0;
  if (anyFailed) {
    console.error("\nOne or more networks failed validation.");
    process.exit(1);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
