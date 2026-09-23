// Down-project one validated card market into the non-strict v0 index shape.
// Do not run the result through validateCard: the card schema rejects caip19_id.

import {
  DEFAULT_CORRIDOR,
  legacyAssetId,
  legacyMarketCorridor,
  pairSideLabel,
  type Card,
  type IndexMarket,
  type Market,
} from "./types.ts";

function stamp(entry: IndexMarket, card: Card): IndexMarket {
  if (card.discovery_pubkey) entry.discovery_pubkey = card.discovery_pubkey;
  if (card.transports) entry.transports = card.transports;
  return entry;
}

/** Legacy (`pair` set) is copied. Canonical is rewritten to short id + caip19_id, or excluded when a side has no v0 name. */
export function indexMarketFromCard(
  card: Card,
  market: Market,
): { ok: true; market: IndexMarket } | { ok: false; excluded: string } {
  // An already-signed legacy card is already in the v0 index shape. Keep
  // its bytes semantically intact instead of trying to down-project the
  // short ids a second time.
  if (market.pair !== undefined) {
    return { ok: true, market: stamp({ ...market, solver: card.name }, card) };
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
  return { ok: true, market: stamp(entry, card) };
}
