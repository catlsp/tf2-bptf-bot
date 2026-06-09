import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { round2, sleep } from '../lib/utils.js';
import { errMessage } from '../lib/errors.js';
import { redis } from '../integrations/redis.js';
import { currentKeyRef } from '../integrations/bptf.js';
import { fetchPricedbItem, type PricedbRow } from './pricedbFeed.js';

// Authoritative reference price oracle, sourced from pricedb.io (the same source
// the tf2autobot-pricedb fork uses in place of prices.tf). Every trade and
// listing price is clamped to these buy/sell rails so a noisy or crossed bp.tf
// order book can never produce a mispriced trade. The order book still decides
// where to sit *within* the rails for competitiveness.
//
// Coverage: pricedb's bulk /api/prices is only the ~100 most-recently-priced
// items (a rotating window), far too sparse to cover our watch set. So the oracle
// fetches the authoritative per-SKU price (/api/item/{sku}) for exactly the SKUs
// in the Redis watch set, throttled, once per refresh.
//
// Prices are denominated in refined: keys are folded in at the live key→ref rate
// (currentKeyRef) at read time, so a moving key price stays consistent with the
// rest of the bot. A price older than MAX_PRICE_AGE_SEC is treated as missing, so
// genuinely abandoned prices expire while transient fetch blips keep last-good.

// Mirrors the watch set key written by refreshWatchList / read by listingRefresh.
const WATCHLIST_KEY = 'bptf:ob:watch';
// Spacing between per-SKU requests — gentle on pricedb (≈8 req/s) and well under
// any sane rate limit at ~60 SKUs/refresh.
const FETCH_SPACING_MS = 120;
// Ignore a reference price older than this (pricedb stamps each row's `time`).
const MAX_PRICE_AGE_SEC = 14 * 24 * 60 * 60; // 14 days

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
 * Refresh the oracle by pulling the authoritative per-SKU price for every SKU in
 * the watch set. Accumulates into the existing cache: a successful fetch updates
 * that SKU; a failed one keeps its last-good entry (so a transient blip doesn't
 * strip coverage — genuinely stale prices expire via MAX_PRICE_AGE_SEC on read).
 * Never wipes the cache when every fetch fails (full outage).
 */
export async function refreshPriceOracle(): Promise<number> {
  let skus: string[];
  try {
    skus = await redis.smembers(WATCHLIST_KEY);
  } catch (e) {
    logger.warn({ err: errMessage(e) }, '[oracle] could not read watch set — keeping existing reference prices');
    return cache.size;
  }
  if (skus.length === 0) {
    logger.warn('[oracle] watch set empty — keeping existing reference prices');
    return cache.size;
  }

  const next = new Map(cache); // accumulate; refresh the watched SKUs in place
  let priced = 0;
  let unpriced = 0;
  for (const sku of skus) {
    const row = await fetchPricedbItem(sku);
    const raw = row ? toRaw(row) : null;
    if (raw) {
      next.set(sku, raw);
      priced++;
    } else {
      unpriced++;
    }
    await sleep(FETCH_SPACING_MS);
  }

  if (priced === 0) {
    logger.warn({ attempted: skus.length }, '[oracle] no pricedb prices returned — keeping existing cache');
    return cache.size;
  }
  cache = next;
  lastRefreshAt = Date.now();
  logger.info({ priced, unpriced, total: skus.length }, '[oracle] reference prices refreshed (per-SKU)');
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
  // Expire genuinely stale prices (pricedb stamps `time` in unix seconds). time
  // === 0 means "unknown age" — keep it rather than wrongly expiring.
  if (raw.time > 0 && Date.now() / 1000 - raw.time > MAX_PRICE_AGE_SEC) return null;
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
