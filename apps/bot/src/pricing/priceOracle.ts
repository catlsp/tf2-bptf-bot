import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { round2 } from '../lib/utils.js';
import { currentKeyRef } from '../integrations/bptf.js';
import { fetchPricedbRows, type PricedbRow } from './pricedbFeed.js';

// Authoritative reference price oracle, sourced from pricedb.io (the same source
// the tf2autobot-pricedb fork uses in place of prices.tf). Every trade and
// listing price is clamped to these buy/sell rails so a noisy or crossed bp.tf
// order book can never produce a mispriced trade. The order book still decides
// where to sit *within* the rails for competitiveness.
//
// Prices are denominated in refined: keys are folded in at the live key→ref rate
// (currentKeyRef) at read time, so a moving key price stays consistent with the
// rest of the bot.

export interface RefPrice {
  skuKey: string;
  /** pricedb BUY price in refined (keys folded in). Hard ceiling on our bids. */
  buyRef: number;
  /** pricedb SELL price in refined (keys folded in). Hard floor on our asks. */
  sellRef: number;
  /** keys+metal as published, kept so reads can re-fold a changed key rate. */
  buyKeys: number;
  buyMetal: number;
  sellKeys: number;
  sellMetal: number;
  /** Unix seconds pricedb last updated this row. */
  time: number;
}

interface RawRef {
  skuKey: string;
  buyKeys: number;
  buyMetal: number;
  sellKeys: number;
  sellMetal: number;
  time: number;
}

let cache = new Map<string, RawRef>();
let lastRefreshAt: number | null = null;

function toRaw(row: PricedbRow): RawRef | null {
  if (typeof row.sku !== 'string' || row.sku.length === 0) return null;
  if (!row.buy || !row.sell) return null;
  const buyKeys = row.buy.keys ?? 0;
  const buyMetal = row.buy.metal ?? 0;
  const sellKeys = row.sell.keys ?? 0;
  const sellMetal = row.sell.metal ?? 0;
  // A row with no price on either side is useless as a rail.
  if (buyKeys === 0 && buyMetal === 0 && sellKeys === 0 && sellMetal === 0) return null;
  return {
    skuKey: row.sku,
    buyKeys,
    buyMetal,
    sellKeys,
    sellMetal,
    time: typeof row.time === 'number' ? row.time : 0,
  };
}

/** Fold a (keys, metal) reference into refined at the current key rate. */
function foldRef(keys: number, metal: number): number {
  return round2(keys * currentKeyRef() + metal);
}

/**
 * Refresh the oracle from pricedb.io. Never clobbers a good cache on failure: an
 * empty/failed fetch keeps the previous prices in place.
 */
export async function refreshPriceOracle(): Promise<number> {
  const rows = await fetchPricedbRows();
  if (rows.length === 0) {
    logger.warn({ cached: cache.size }, '[oracle] pricedb feed empty — keeping existing reference prices');
    return cache.size;
  }
  const next = new Map<string, RawRef>();
  for (const row of rows) {
    const raw = toRaw(row);
    if (raw) next.set(raw.skuKey, raw);
  }
  if (next.size === 0) {
    logger.warn('[oracle] pricedb feed had no usable rows — keeping existing reference prices');
    return cache.size;
  }
  cache = next;
  lastRefreshAt = Date.now();
  logger.info({ count: cache.size }, '[oracle] reference prices refreshed from pricedb.io');
  return cache.size;
}

/**
 * Reference buy/sell rails for a SKU, in refined at the current key rate. Returns
 * null when pricedb has no usable price — callers treat that as "do not trade
 * this SKU" (hard-rails policy).
 */
export function getRefPrice(skuKey: string): RefPrice | null {
  const raw = cache.get(skuKey);
  if (!raw) return null;
  return {
    skuKey: raw.skuKey,
    buyRef: foldRef(raw.buyKeys, raw.buyMetal),
    sellRef: foldRef(raw.sellKeys, raw.sellMetal),
    buyKeys: raw.buyKeys,
    buyMetal: raw.buyMetal,
    sellKeys: raw.sellKeys,
    sellMetal: raw.sellMetal,
    time: raw.time,
  };
}

export function oracleSize(): number {
  return cache.size;
}

export function oracleLastRefreshAt(): number | null {
  return lastRefreshAt;
}

let timer: NodeJS.Timeout | null = null;

/** Kick an immediate refresh, then refresh on PRICEDB_REFRESH_SEC. */
export function startPriceOracle(): void {
  void refreshPriceOracle();
  timer = setInterval(() => void refreshPriceOracle(), env.PRICEDB_REFRESH_SEC * 1000);
}

export function stopPriceOracle(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: replace the cache directly (used by unit tests, never in prod). */
export function __setOracleCacheForTest(rows: RawRef[]): void {
  cache = new Map(rows.map((r) => [r.skuKey, r]));
}
