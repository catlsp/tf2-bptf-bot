import { writeFile } from 'node:fs/promises';
import { redis } from '../integrations/redis.js';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { loadWatchList, WATCH_LIST_PATH } from '../orderbook/orderBook.js';
import { fetchPricedbRows, type PricedbRow } from '../pricing/pricedbFeed.js';
import { getSeedWatchlist } from './seed.js';

// Builds the watch list dynamically from pricedb.io's priced feed, filtered to
// affordable items (pure-metal buy at/below WATCH_MAX_BUY_REF) and unioned with
// the hand-picked seed base, so the bot tracks a stable set of cheap, liquid junk
// rather than key-priced items it can't fund. Writes config/watch-list.json,
// refreshes the Redis watch set, and caches names. Never overwrites a good list
// on failure.

const TOP_N = 300;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NAMES_KEY = 'bptf:ob:names';

// Always tracked, even if not in the top 300 — needed for currency conversion.
const CURRENCY_FALLBACK = ['5021;6', '5002;6', '5001;6', '5000;6'];

export async function refreshWatchList(): Promise<void> {
  // Manual mode pins the list to config/watch-list.json. Never fetch pricedb,
  // never overwrite — just (re)load the hardcoded file into Redis.
  if (env.WATCHLIST_MODE === 'manual') {
    try {
      const count = await loadWatchList();
      logger.info({ count }, '[watchlist] manual mode — pinned to config/watch-list.json, auto-refresh disabled');
    } catch (e) {
      logger.warn({ err: errMessage(e) }, '[watchlist] manual reload failed');
    }
    return;
  }

  const rows = await fetchPricedbRows();
  if (rows.length === 0) {
    logger.warn('[watchlist] pricedb.io returned no rows, keeping existing list');
    return;
  }

  // pricedb's priced feed is already newest-first. Keep only items inside the
  // junk-flip capital band (pure-metal buy at/below WATCH_MAX_BUY_REF), then union
  // with the hand-picked seed base and the currency SKUs.
  const affordable = rows.filter(
    (r): r is PricedbRow & { sku: string } =>
      typeof r.sku === 'string' &&
      r.sku.length > 0 &&
      r.buy != null &&
      !r.buy.keys &&
      typeof r.buy.metal === 'number' &&
      r.buy.metal > 0 &&
      r.buy.metal <= env.WATCH_MAX_BUY_REF,
  );

  const skuSet = new Set<string>(CURRENCY_FALLBACK);
  const names: Record<string, string> = {};
  for (const seed of getSeedWatchlist(1000)) skuSet.add(seed.skuKey);
  for (const r of affordable.slice(0, TOP_N)) {
    skuSet.add(r.sku);
    if (r.name) names[r.sku] = r.name;
  }
  const skus = [...skuSet];

  const doc = { updated_at: new Date().toISOString(), count: skus.length, skus };
  try {
    await writeFile(WATCH_LIST_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (e) {
    logger.warn({ err: errMessage(e) }, '[watchlist] failed to write watch-list.json, keeping in-memory only');
  }

  // refresh Redis watch set + name cache. Merge names (don't wipe) so the price
  // oracle's per-SKU names — which cover SKUs the bulk feed doesn't — survive.
  await loadWatchList();
  try {
    if (Object.keys(names).length > 0) await redis.hset(NAMES_KEY, names);
  } catch (e) {
    logger.debug({ err: errMessage(e) }, '[watchlist] name cache update failed');
  }

  logger.info(
    { count: skus.length, affordable: affordable.length },
    `[watchlist] loaded ${skus.length} SKUs (seed base + pricedb affordable)`,
  );
}

export async function getSkuName(sku: string): Promise<string | null> {
  try {
    return await redis.hget(NAMES_KEY, sku);
  } catch {
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;
export function startWatchListScheduler(): void {
  void refreshWatchList();
  timer = setInterval(() => void refreshWatchList(), REFRESH_INTERVAL_MS);
}

export function stopWatchListScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
