import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchFeedValue, type FetchFeedOptions } from "./feed.ts";
import { planOffer, type OfferPlan } from "./offer.ts";
import { otherSide, sideLimits } from "./pricing.ts";
import { isSameAssetMarket, stableStringify, type Market, type Side } from "./types.ts";

type InitialAmount = string | number | bigint;

type InitialAmountOptions =
  | { initialGiveAmount?: InitialAmount; initialWantAmount?: never }
  | { initialGiveAmount?: never; initialWantAmount?: InitialAmount };

export type OfferQuoteInputSide = "give" | "want";
export type OfferQuoteStatus = "idle" | "loading" | "success" | "error";

export type UseOfferQuoteOptions = FetchFeedOptions & {
  /** Which side the maker deposits. Defaults to `base`. */
  give?: Side;
  safetyBps?: number;
} & InitialAmountOptions;

export interface UseOfferQuoteResult {
  market: Market | null;
  give: Side;
  /**
   * Whether the market can pay out the side the maker receives (the opposite of
   * `give`): that side's max bound is > 0. `null` while no market is selected.
   * A `false` here means this give-direction can never fill on this market —
   * UIs should disable the form or switch market/direction.
   */
  solvable: boolean | null;
  activeInput: OfferQuoteInputSide;
  setActiveInput(input: OfferQuoteInputSide): void;
  giveAmount: string;
  wantAmount: string;
  setGiveAmount(amount: string): void;
  setWantAmount(amount: string): void;
  feedValue: string | number | null;
  plan: OfferPlan | null;
  status: OfferQuoteStatus;
  error: Error | null;
  refresh(): void;
}

function initialAmount(value: InitialAmount | undefined): string {
  return value === undefined ? "" : String(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Everything derived from a feed fetch, tagged with the (market, give)
 * identity it was computed for. The hook only exposes it while that identity
 * still matches the current props, so a market or direction switch can never
 * show the previous market's plan, price, or status — not even for one render
 * frame. Identity is the market's VALUE (stableStringify, the same identity
 * discovery dedupes with), not its object reference: a background discover()
 * refresh that re-creates a byte-identical market keeps the quote alive with
 * no refetch, while an in-place content change is detected and invalidates it.
 */
interface QuoteState {
  key: string;
  give: Side;
  feedValue: string | number | null;
  plan: OfferPlan | null;
  status: OfferQuoteStatus;
  error: Error | null;
}

/** The state, but only if it was computed for the current (market, give) identity. */
function matching(s: QuoteState | null, key: string | null, give: Side): QuoteState | null {
  return s && s.key === key && s.give === give ? s : null;
}

/**
 * React helper for a two-input quote UI. The last edited amount drives the
 * quote: editing the base/give side updates the wanted side, and editing the
 * wanted side computes the minimum deposit.
 */
export function useOfferQuote(
  market: Market | null | undefined,
  opts: UseOfferQuoteOptions = {},
): UseOfferQuoteResult {
  const {
    fetchImpl,
    give = "base",
    initialGiveAmount,
    initialWantAmount,
    safetyBps,
    signal,
    timeoutMs,
  } = opts;
  const [activeInput, setActiveInput] = useState<OfferQuoteInputSide>(() =>
    initialWantAmount !== undefined ? "want" : "give",
  );
  const [giveAmount, setGiveAmountValue] = useState(() => initialAmount(initialGiveAmount));
  const [wantAmount, setWantAmountValue] = useState(() => initialAmount(initialWantAmount));
  const [quoteState, setQuoteState] = useState<QuoteState | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Read the fetch implementation through a ref so an inline `fetchImpl`
  // lambda (a new identity every render) cannot re-arm the effect after each
  // completed fetch and poll the feed forever.
  const fetchImplRef = useRef(fetchImpl);
  fetchImplRef.current = fetchImpl;
  // The last machine-written mirror amount, tagged with the identity it was
  // computed for, so a market/direction switch can clear it — unless the user
  // has overwritten it since.
  const mirrorRef = useRef<{ key: string; give: Side; input: OfferQuoteInputSide; value: string } | null>(null);

  const setGiveAmount = useCallback((amount: string) => {
    setActiveInput("give");
    setGiveAmountValue(amount);
  }, []);

  const setWantAmount = useCallback((amount: string) => {
    setActiveInput("want");
    setWantAmountValue(amount);
  }, []);

  const refresh = useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  const activeAmount = activeInput === "give" ? giveAmount : wantAmount;
  // Solvability is a static market property — known before any feed fetch.
  const solvable = market ? sideLimits(market, otherSide(give)) !== null : null;
  // Recomputed every render (not memoized by reference) so even an in-place
  // mutation of the market object changes the identity.
  const marketKey = market ? stableStringify(market) : null;

  useEffect(() => {
    const carried = (s: QuoteState | null) => matching(s, marketKey, give);

    // The mirrored counterpart amount lives outside the identity-keyed atom
    // (it is a user-editable input): when it was machine-written for another
    // (market, give) identity and the user has not touched it since, clear it
    // so another market's computed amount is never shown under this one.
    const mirror = mirrorRef.current;
    if (mirror && (mirror.key !== marketKey || mirror.give !== give)) {
      const clearIfUnedited = (prev: string) => (prev === mirror.value ? "" : prev);
      if (mirror.input === "give") setWantAmountValue(clearIfUnedited);
      else setGiveAmountValue(clearIfUnedited);
      mirrorRef.current = null;
    }

    if (!market || !solvable || activeAmount.trim() === "") {
      // Nothing to quote: no market, a receive side the market cannot pay out
      // (`solvable` tells the UI which), or no input. With a market selected,
      // clear the computed counterpart so a stale mirrored amount never
      // lingers — but keep both amounts across deselection (`market` null),
      // where the inactive field may hold user input (e.g. an initial amount
      // seeded before discovery finished).
      if (market) {
        if (activeInput === "give") setWantAmountValue("");
        else setGiveAmountValue("");
      }
      // Keep a solvable market's last feed value across an emptied input;
      // everything else resets to idle. Return the same object when nothing
      // changes so React can bail out of the update.
      setQuoteState((s) => {
        const cur = market && solvable ? carried(s) : null;
        if (cur === null) return null;
        if (cur.plan === null && cur.status === "idle" && cur.error === null) return s;
        return { ...cur, plan: null, status: "idle", error: null };
      });
      return;
    }

    const selectedMarket = market;
    let cancelled = false;
    const controller = new AbortController();
    let relayAbort: (() => void) | undefined;
    if (signal) {
      relayAbort = () => controller.abort(signal.reason);
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", relayAbort, { once: true });
    }

    // Loading: keep the same identity's previous feed value and plan visible.
    // Bail out (same object) when already loading, so an unstable dep (inline
    // fetchImpl, re-created market prop) cannot self-sustain a render loop.
    const key = marketKey as string;
    setQuoteState((s) => {
      const cur = carried(s);
      if (cur && cur.status === "loading") return s;
      return {
        key,
        give,
        feedValue: cur?.feedValue ?? null,
        plan: cur?.plan ?? null,
        status: "loading",
        error: null,
      };
    });

    async function quote() {
      try {
        // A same-asset corridor market has no feed and prices at exactly 1;
        // planOffer needs no feed value there, and the state keeps feedValue
        // null so consumers can't mistake the fixed 1:1 for fetched data.
        let nextFeedValue: string | number | undefined;
        if (isSameAssetMarket(selectedMarket)) {
          // nothing to fetch
        } else if (selectedMarket.price_feed === undefined || selectedMarket.price_feed_schema === undefined) {
          throw new Error("cross-asset market advertises no price feed");
        } else {
          nextFeedValue = await fetchFeedValue(
            selectedMarket.price_feed,
            selectedMarket.price_feed_schema,
            {
              fetchImpl: fetchImplRef.current,
              signal: controller.signal,
              timeoutMs,
            },
          );
        }
        const nextPlan =
          activeInput === "give"
            ? planOffer({
                market: selectedMarket,
                give,
                giveAmount: activeAmount,
                feedValue: nextFeedValue,
                safetyBps,
              })
            : planOffer({
                market: selectedMarket,
                give,
                wantAmount: activeAmount,
                feedValue: nextFeedValue,
                safetyBps,
              });

        if (cancelled) return;
        setQuoteState({
          key,
          give,
          feedValue: nextFeedValue ?? null,
          plan: nextPlan,
          status: "success",
          error: null,
        });
        const mirrored = activeInput === "give" ? nextPlan.receive.display : nextPlan.deposit.display;
        mirrorRef.current = { key, give, input: activeInput, value: mirrored };
        if (activeInput === "give") setWantAmountValue(mirrored);
        else setGiveAmountValue(mirrored);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setQuoteState((s) => ({
          key,
          give,
          feedValue: carried(s)?.feedValue ?? null,
          plan: null,
          status: "error",
          error: asError(err),
        }));
      }
    }

    quote();

    return () => {
      cancelled = true;
      if (signal && relayAbort) signal.removeEventListener("abort", relayAbort);
      controller.abort();
    };
    // `market` is deliberately keyed by value (marketKey): a re-created but
    // byte-identical market object must not abort and refetch.
  }, [activeAmount, activeInput, give, marketKey, refreshNonce, safetyBps, signal, solvable, timeoutMs]);

  return useMemo(() => {
    // Expose quote state only while its identity matches the current props —
    // stale cross-market values are structurally unreachable.
    const current = matching(quoteState, marketKey, give);
    return {
      market: market ?? null,
      give,
      solvable,
      activeInput,
      setActiveInput,
      giveAmount,
      wantAmount,
      setGiveAmount,
      setWantAmount,
      feedValue: current?.feedValue ?? null,
      plan: current?.plan ?? null,
      status: current?.status ?? "idle",
      error: current?.error ?? null,
      refresh,
    };
  }, [
    activeInput,
    give,
    giveAmount,
    market,
    marketKey,
    quoteState,
    refresh,
    setGiveAmount,
    setWantAmount,
    solvable,
    wantAmount,
  ]);
}
