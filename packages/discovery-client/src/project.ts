// ponytail: index shape is non-strict. validateCard rejects caip19_id, so the projection is not re-checked.

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

export function indexMarketFromCard(
  card: Card,
  market: Market,
): { ok: true; market: IndexMarket } | { ok: false; excluded: string } {
  // ponytail: a set pair is already v0. legacyAssetId("btc") is undefined and would drop the market.
  if (market.pair !== undefined) return { ok: true, market: stamp({ ...market, solver: card.name }, card) };
  const baseCorridor = legacyMarketCorridor(market, "base");
  const quoteCorridor = legacyMarketCorridor(market, "quote");
  const base = legacyAssetId(market.base_asset.id);
  const quote = legacyAssetId(market.quote_asset.id);
  if (base === undefined || quote === undefined) {
    return { ok: false, excluded: `${card.name}: ${market.base_asset.id} -> ${market.quote_asset.id}` };
  }
  const entry: IndexMarket = {
    ...market,
    base_asset: { ...market.base_asset, id: base, caip19_id: market.base_asset.id },
    quote_asset: { ...market.quote_asset, id: quote, caip19_id: market.quote_asset.id },
    solver: card.name,
    pair: `${pairSideLabel(baseCorridor, market.base_asset.ticker)}/${pairSideLabel(quoteCorridor, market.quote_asset.ticker)}`,
  };
  if (baseCorridor !== DEFAULT_CORRIDOR) entry.base_corridor = baseCorridor;
  if (quoteCorridor !== DEFAULT_CORRIDOR) entry.quote_corridor = quoteCorridor;
  return { ok: true, market: stamp(entry, card) };
}
