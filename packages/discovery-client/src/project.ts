// Down-project one card market into the v0 index shape.
//
// A published index and a pinned local card have to be readable by the same
// consumers: short `id` for pricing and balance matching, `caip19_id` keeping
// the CAIP-19 form so leg keys, findMarket, and carrier detection still see
// the rail and `/asset:`. The reducer and discover() both call this so a
// pinned canonical card is not left with the CAIP string in `asset.id`.
//
// Index entries are the non-strict shape. Do not run the result back through
// validateCard — the card schema rejects `caip19_id`.

import {
  DEFAULT_CORRIDOR,
  legacyAssetId,
  legacyMarketCorridor,
  pairSideLabel,
  type Card,
  type IndexMarket,
  type Market,
} from "./types.ts";

export type IndexMarketFromCard =
  | { ok: true; market: IndexMarket }
  | { ok: false; excluded: string };

function stampRendezvous(entry: IndexMarket, card: Pick<Card, "discovery_pubkey" | "transports">): IndexMarket {
  if (card.discovery_pubkey) entry.discovery_pubkey = card.discovery_pubkey;
  if (card.transports) entry.transports = card.transports;
  return entry;
}

/**
 * Project one market of a validated card into an index entry.
 *
 * A legacy market (`pair` set, ids already short) is copied and stamped with
 * the card's solver, pubkey, and transports. A canonical market is rewritten
 * to the short id plus `caip19_id`, with `pair` filled from the tickers and
 * `base_corridor` / `quote_corridor` set only when the legacy corridor is not
 * arkade. A side this cannot name (an `eip155` id, or anything else outside
 * the v0 grammar) excludes the market instead of failing the card.
 */
export function indexMarketFromCard(
  card: Pick<Card, "name" | "discovery_pubkey" | "transports">,
  market: Market,
): IndexMarketFromCard {
  // An already-signed legacy card is already in the v0 index shape. Keep its
  // bytes semantically intact instead of trying to down-project the short ids
  // a second time.
  if (market.pair !== undefined) {
    const entry: IndexMarket = { ...market, solver: card.name };
    return { ok: true, market: stampRendezvous(entry, card) };
  }
  const baseCorridor = legacyMarketCorridor(market, "base");
  const quoteCorridor = legacyMarketCorridor(market, "quote");
  // No v0 id would fail the whole document for v0 clients: held out, named.
  const legacy = {
    base: legacyAssetId(market.base_asset.id),
    quote: legacyAssetId(market.quote_asset.id),
  };
  if (legacy.base === undefined || legacy.quote === undefined) {
    return { ok: false, excluded: `${card.name}: ${market.base_asset.id} -> ${market.quote_asset.id}` };
  }
  const entry: IndexMarket = {
    ...market,
    base_asset: { ...market.base_asset, id: legacy.base, caip19_id: market.base_asset.id },
    quote_asset: { ...market.quote_asset, id: legacy.quote, caip19_id: market.quote_asset.id },
    solver: card.name,
    pair: `${pairSideLabel(baseCorridor, market.base_asset.ticker)}/${pairSideLabel(quoteCorridor, market.quote_asset.ticker)}`,
  };
  if (baseCorridor !== DEFAULT_CORRIDOR) entry.base_corridor = baseCorridor;
  if (quoteCorridor !== DEFAULT_CORRIDOR) entry.quote_corridor = quoteCorridor;
  return { ok: true, market: stampRendezvous(entry, card) };
}
