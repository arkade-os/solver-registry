import type { DiscoveredMarket } from "./discovery.ts";
import type { FetchLike } from "./feed.ts";
import { quoteOffer } from "./offer.ts";
import { otherSide } from "./pricing.ts";
import { assetIdOf, marketCorridor, marketLegKey, type Market, type Side } from "./types.ts";

export type SolverOrder = "manual" | "usage" | "cost";

export interface SolverRoutingPreferences {
  mode?: SolverOrder;
  priority?: readonly string[];
  /** Try this solver ID first; the remaining eligible solvers still follow mode ordering. */
  preferFirst?: string;
  usage?: Readonly<Record<string, number>>;
  /** Temporary reliability demotion, before preference or mode; still eligible as a fallback. */
  deprioritized?: readonly string[];
  /** Exclude these solver IDs before ordering or requesting advertised-cost feeds. */
  disabled?: readonly string[];
}

export interface SolverMarket {
  readonly card: DiscoveredMarket;
  readonly give: Side;
}

/** Scope preference bookkeeping to provenance; a claimed key does not authenticate a solver. */
export function solverId(
  card: Pick<DiscoveredMarket, "solver" | "source" | "discovery_pubkey"> & Partial<Pick<DiscoveredMarket, "sourceType">>,
  network: string,
): string {
  return JSON.stringify([network, card.sourceType ?? "unknown", card.source, card.solver, card.discovery_pubkey ?? null]);
}

/** Normalize legacy legs for preference keys without changing marketLegKey's compatibility behavior. */
function directionLeg(card: Market, side: Side, network: string): string {
  const id = assetIdOf(side === "base" ? card.base_asset : card.quote_asset);
  if (id?.includes("/")) return id;
  const rail = marketCorridor(card, side);
  if (id === "btc") return `${rail}:${network}/slip44:${network === "bitcoin" ? 0 : 1}`;
  if (id && /^[0-9a-f]{68}$/.test(id)) return `${rail}:${network}/asset:${id}`;
  return marketLegKey(card, side);
}

/** Identify a network and ordered give/take asset rails, including canonicalized legacy legs. */
export function solverDirectionKey(card: Market, give: Side, network: string): string {
  return JSON.stringify([network, directionLeg(card, give, network), directionLeg(card, otherSide(give), network)]);
}

/** Exclude disabled solvers, then order stably; cost mode without an amount uses manual order. */
export function orderSolverMarkets<T extends SolverMarket>(
  candidates: readonly T[],
  options: { network: string; preferences?: SolverRoutingPreferences },
): T[] {
  const { network, preferences } = options;
  const disabled = new Set(preferences?.disabled ?? []);
  const deprioritized = new Set(preferences?.deprioritized ?? []);
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
    .filter(({ id }) => !disabled.has(id))
    .sort((a, b) => {
      const health = Number(deprioritized.has(a.id)) - Number(deprioritized.has(b.id));
      if (health) return health;
      const preferred = Number(b.id === preferences?.preferFirst) - Number(a.id === preferences?.preferFirst);
      if (preferred) return preferred;
      if (preferences?.mode === "usage") {
        const usage = usageCount(b.id) - usageCount(a.id);
        if (usage !== 0) return usage;
      }
      return (priority.get(a.id) ?? priority.size) - (priority.get(b.id) ?? priority.size) || a.index - b.index;
    })
    .map(({ candidate }) => candidate);
}

/** Rank advertised amount estimates within each direction; caller cancellation rejects the whole ranking. */
export async function rankSolverMarkets<T extends SolverMarket>(
  candidates: readonly T[],
  options: {
    network: string;
    preferences?: SolverRoutingPreferences;
    amount?: { on: "give" | "take"; value: bigint };
    carrierSats?: bigint;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<T[]> {
  const { amount } = options;
  options.signal?.throwIfAborted();
  if (amount && amount.value <= 0n) throw new Error("amount must be positive");
  const ordered = orderSolverMarkets(candidates, options);
  if (options.preferences?.mode !== "cost" || !amount) return ordered;
  const deprioritized = new Set(options.preferences.deprioritized ?? []);

  const groups = new Map<string, T[]>();
  const enabled = new Set(ordered);
  for (const candidate of candidates) {
    if (!enabled.has(candidate)) continue;
    groups.set(solverDirectionKey(candidate.card, candidate.give, options.network), []);
  }
  for (const candidate of ordered) {
    groups.get(solverDirectionKey(candidate.card, candidate.give, options.network))!.push(candidate);
  }
  const pending = Promise.all(Array.from(groups.values(), async (group) => {
    const estimates = await Promise.all(group.map(async (candidate, index) => {
      const id = solverId(candidate.card, options.network);
      const cooling = deprioritized.has(id);
      let cost: bigint | undefined;
      try {
        const plan = cooling ? undefined : await quoteOffer(candidate.card, {
          give: candidate.give,
          safetyBps: 0,
          carrierSats: options.carrierSats,
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          ...(amount.on === "give" ? { giveAmount: amount.value } : { wantAmount: amount.value }),
        });
        if (plan && plan.limits.withinLimits && plan.receive.atomic > 0n && plan.deposit.atomic > 0n) {
          cost = amount.on === "give" ? -plan.receive.atomic : plan.deposit.atomic;
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error !== null && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
        // One unavailable feed or invalid plan must not hide other solvers.
      }
      return { candidate, index, cost, cooling, preferred: id === options.preferences?.preferFirst };
    }));
    return estimates.sort((a, b) => {
      const health = Number(a.cooling) - Number(b.cooling);
      if (health) return health;
      const preferred = Number(b.preferred) - Number(a.preferred);
      if (preferred) return preferred;
      if (a.cost === undefined) return b.cost === undefined ? a.index - b.index : 1;
      if (b.cost === undefined) return -1;
      return a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : a.index - b.index;
    }).map(({ candidate }) => candidate);
  }));
  const signal = options.signal;
  if (!signal) return (await pending).flat();
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return (await Promise.race([pending, cancelled])).flat();
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
