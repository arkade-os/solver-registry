import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchFeedValue, type FetchFeedOptions } from "./feed.ts";
import { planOffer, type OfferPlan, type OfferSide } from "./offer.ts";
import type { Market } from "./types.ts";

type InitialAmount = string | number | bigint;

type InitialAmountOptions =
  | { initialGiveAmount?: InitialAmount; initialWantAmount?: never }
  | { initialGiveAmount?: never; initialWantAmount?: InitialAmount };

export type OfferQuoteInputSide = "give" | "want";
export type OfferQuoteStatus = "idle" | "loading" | "success" | "error";

export type UseOfferQuoteOptions = FetchFeedOptions & {
  /** Which side the maker deposits. Defaults to `base`. */
  give?: OfferSide;
  safetyBps?: number;
} & InitialAmountOptions;

export interface UseOfferQuoteResult {
  market: Market | null;
  give: OfferSide;
  activeInput: OfferQuoteInputSide;
  setActiveInput(input: OfferQuoteInputSide): void;
  giveAmount: string;
  wantAmount: string;
  setGiveAmount(amount: string): void;
  setWantAmount(amount: string): void;
  /** Pair-oriented aliases for UIs with base/quote inputs. */
  baseAmount: string;
  quoteAmount: string;
  setBaseAmount(amount: string): void;
  setQuoteAmount(amount: string): void;
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
 * React helper for a two-input quote UI. The last edited amount drives the
 * quote: editing the base/give side updates the wanted side, and editing the
 * wanted side computes the minimum deposit.
 */
export function useOfferQuote(
  market: Market | null | undefined,
  opts: UseOfferQuoteOptions = {},
): UseOfferQuoteResult {
  const {
    extractPrice,
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
  const [feedValue, setFeedValue] = useState<string | number | null>(null);
  const [plan, setPlan] = useState<OfferPlan | null>(null);
  const [status, setStatus] = useState<OfferQuoteStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const setGiveAmount = useCallback((amount: string) => {
    setActiveInput("give");
    setGiveAmountValue(amount);
  }, []);

  const setWantAmount = useCallback((amount: string) => {
    setActiveInput("want");
    setWantAmountValue(amount);
  }, []);

  const setBaseAmount = useCallback(
    (amount: string) => {
      if (give === "base") setGiveAmount(amount);
      else setWantAmount(amount);
    },
    [give, setGiveAmount, setWantAmount],
  );

  const setQuoteAmount = useCallback(
    (amount: string) => {
      if (give === "base") setWantAmount(amount);
      else setGiveAmount(amount);
    },
    [give, setGiveAmount, setWantAmount],
  );

  const refresh = useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  const activeAmount = activeInput === "give" ? giveAmount : wantAmount;

  useEffect(() => {
    if (!market) {
      setFeedValue(null);
      setPlan(null);
      setStatus("idle");
      setError(null);
      return;
    }

    if (activeAmount.trim() === "") {
      if (activeInput === "give") setWantAmountValue("");
      else setGiveAmountValue("");
      setPlan(null);
      setStatus("idle");
      setError(null);
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

    setStatus("loading");
    setError(null);

    async function quote() {
      try {
        const nextFeedValue = await fetchFeedValue(selectedMarket.price_feed, {
          extractPrice,
          fetchImpl,
          signal: controller.signal,
          timeoutMs,
        });
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
        setFeedValue(nextFeedValue);
        setPlan(nextPlan);
        setStatus("success");
        if (activeInput === "give") setWantAmountValue(nextPlan.receive.display);
        else setGiveAmountValue(nextPlan.deposit.display);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setPlan(null);
        setStatus("error");
        setError(asError(err));
      }
    }

    quote();

    return () => {
      cancelled = true;
      if (signal && relayAbort) signal.removeEventListener("abort", relayAbort);
      controller.abort();
    };
  }, [activeAmount, activeInput, extractPrice, fetchImpl, give, market, refreshNonce, safetyBps, signal, timeoutMs]);

  return useMemo(() => {
    const baseAmount = give === "base" ? giveAmount : wantAmount;
    const quoteAmount = give === "base" ? wantAmount : giveAmount;
    return {
      market: market ?? null,
      give,
      activeInput,
      setActiveInput,
      giveAmount,
      wantAmount,
      setGiveAmount,
      setWantAmount,
      baseAmount,
      quoteAmount,
      setBaseAmount,
      setQuoteAmount,
      feedValue,
      plan,
      status,
      error,
      refresh,
    };
  }, [
    activeInput,
    error,
    feedValue,
    give,
    giveAmount,
    market,
    plan,
    refresh,
    setBaseAmount,
    setGiveAmount,
    setQuoteAmount,
    setWantAmount,
    status,
    wantAmount,
  ]);
}
