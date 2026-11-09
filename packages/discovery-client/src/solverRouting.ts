import type { DiscoveredMarket } from "./discovery.ts";
import { quoteOffer } from "./offer.ts";
import { otherSide } from "./pricing.ts";
import { assetIdOf, marketCorridor, marketLegKey, type Market, type Side } from "./types.ts";

export type SolverOrder = "manual" | "usage" | "cost";

export interface SolverRoutingPreferences {
  mode?: SolverOrder;
  priority?: readonly string[];
  usage?: Readonly<Record<string, number>>;
}

export interface SolverMarket {
  readonly card: DiscoveredMarket;
  readonly give: Side;
}

export function solverId(
  card: Pick<DiscoveredMarket, "solver" | "source" | "discovery_pubkey">,
  network: string,
): string {
  return card.discovery_pubkey
    ? JSON.stringify([network, card.discovery_pubkey])
    : JSON.stringify([network, card.source, card.solver]);
}

function directionLeg(card: Market, side: Side, network: string): string {
  const id = assetIdOf(side === "base" ? card.base_asset : card.quote_asset);
  if (id?.includes("/")) return id;
  const rail = marketCorridor(card, side);
  if (id === "btc") return `${rail}:${network}/slip44:${network === "bitcoin" ? 0 : 1}`;
  if (id && /^[0-9a-f]{68}$/.test(id)) return `${rail}:${network}/asset:${id}`;
  return marketLegKey(card, side);
}

export function solverDirectionKey(card: Market, give: Side, network: string): string {
  return JSON.stringify([network, directionLeg(card, give, network), directionLeg(card, otherSide(give), network)]);
}

export function orderSolverMarkets<T extends SolverMarket>(
  candidates: readonly T[],
  options: { network: string; preferences?: SolverRoutingPreferences },
): T[] {
  const { network, preferences } = options;
  const priority = new Map<string, number>();
  for (const id of preferences?.priority ?? []) {
    if (!priority.has(id)) priority.set(id, priority.size);
  }
  const usageCount = (id: string): number => {
    const usage = preferences?.usage;
    const value = usage && Object.hasOwn(usage, id) ? usage[id] : 0;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  return candidates.map((candidate, index) => ({ candidate, index, id: solverId(candidate.card, network) }))
    .sort((a, b) => {
      if (preferences?.mode === "usage") {
        const usage = usageCount(b.id) - usageCount(a.id);
        if (usage !== 0) return usage;
      }
      return (priority.get(a.id) ?? priority.size) - (priority.get(b.id) ?? priority.size) || a.index - b.index;
    })
    .map(({ candidate }) => candidate);
}

export async function rankSolverMarkets<T extends SolverMarket>(
  candidates: readonly T[],
  options: {
    network: string;
    preferences?: SolverRoutingPreferences;
    amount?: { on: "give" | "take"; value: bigint };
    carrierSats?: bigint;
    fetchImpl?: typeof fetch;
  },
): Promise<T[]> {
  const { amount } = options;
  if (amount && amount.value <= 0n) throw new Error("amount must be positive");
  const ordered = orderSolverMarkets(candidates, options);
  if (options.preferences?.mode !== "cost" || !amount) return ordered;

  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    groups.set(solverDirectionKey(candidate.card, candidate.give, options.network), []);
  }
  for (const candidate of ordered) {
    groups.get(solverDirectionKey(candidate.card, candidate.give, options.network))!.push(candidate);
  }
  const ranked = await Promise.all(Array.from(groups.values(), async (group) => {
    const estimates = await Promise.all(group.map(async (candidate, index) => {
      let cost: bigint | undefined;
      try {
        const plan = await quoteOffer(candidate.card, {
          give: candidate.give,
          safetyBps: 0,
          carrierSats: options.carrierSats,
          fetchImpl: options.fetchImpl,
          ...(amount.on === "give" ? { giveAmount: amount.value } : { wantAmount: amount.value }),
        });
        if (plan.limits.withinLimits && plan.receive.atomic > 0n && plan.deposit.atomic > 0n) {
          cost = amount.on === "give" ? -plan.receive.atomic : plan.deposit.atomic;
        }
      } catch {
        // One unavailable feed or invalid plan must not hide other solvers.
      }
      return { candidate, index, cost };
    }));
    return estimates.sort((a, b) => {
      if (a.cost === undefined) return b.cost === undefined ? a.index - b.index : 1;
      if (b.cost === undefined) return -1;
      return a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : a.index - b.index;
    }).map(({ candidate }) => candidate);
  }));
  return ranked.flat();
}
