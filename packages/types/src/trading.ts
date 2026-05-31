// Domain types shared between bot, telegram, and (later) dashboard.

export type ListingIntent = 'BUY' | 'SELL';

/** A TF2 item identity, collapsed into a stable SKU key. */
export interface ItemSku {
  defindex: number;
  quality: number;
  craftable: boolean;
  killstreak: number;
  australium: boolean;
  effect?: number | null;
  /** "defindex;quality;..." — see lib/utils buildSkuKey */
  skuKey: string;
  name: string;
}

/** Price expressed in refined metal (the bot's unit of account). */
export interface PriceRef {
  buyRef: number | null;
  sellRef: number | null;
}

/** Result of a fair-value pull for one SKU. */
export interface FairValue {
  skuKey: string;
  /** mid-point used for decisions */
  fairValueRef: number;
  buyRef: number | null;
  sellRef: number | null;
  source: string;
  capturedAt: Date;
}

/** A single bp.tf listing snapshot. */
export interface MarketListing {
  steamId: string;
  intent: ListingIntent;
  priceRef: number;
  craftable: boolean;
  bumpedAt?: number;
}

/** Aggregated market view for one SKU at scan time. */
export interface MarketSnapshot {
  skuKey: string;
  fairValueRef: number;
  lowestSellRef: number | null;
  highestBuyRef: number | null;
  sellCount: number;
  buyCount: number;
}

/** A buy/sell decision the strategy emits. */
export interface TradeDecision {
  skuKey: string;
  name: string;
  intent: ListingIntent;
  /** what we would pay (BUY) or ask (SELL) */
  priceRef: number;
  fairValueRef: number;
  /** expected profit in ref if the round-trip completes */
  expectedProfitRef: number;
  marginPct: number;
  reason: string;
  /** counterpart steamId for a real offer (Phase 3+); null in paper mode */
  partnerSteamId: string | null;
}

export interface Balance {
  keys: number;
  refined: number;
  /** keys folded into ref using current key price */
  totalRef: number;
  reservedKeys: number;
  reservedRefined: number;
}
