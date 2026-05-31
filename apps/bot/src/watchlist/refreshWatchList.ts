import { writeFile } from 'node:fs/promises';
import axios from 'axios';
import { redis } from '../integrations/redis.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { loadWatchList, WATCH_LIST_PATH } from '../orderbook/orderBook.js';

// Builds the watch list dynamically from pricedb.io's most-recently-updated
// (≈ most liquid) SKUs. Writes config/watch-list.json, refreshes the Redis watch
// set, and caches names for autoprice hydration. Never overwrites a good list on
// failure.

const PRICEDB_URL = 'https://pricedb.io/api/latest-prices';
const TOP_N = 300;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NAMES_KEY = 'bptf:ob:names';

// Always tracked, even if not in the top 300 — needed for currency conversion.
const CURRENCY_FALLBACK = ['5021;6', '5002;6', '5001;6', '5000;6'];

interface PriceRow {
  sku?: string;
  name?: string;
  last_updated?: string | number;
}

function extractRows(data: unknown): PriceRow[] {
  if (Array.isArray(data)) return data as PriceRow[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of ['items', 'prices', 'data', 'results']) {
      if (Array.isArray(obj[k])) return obj[k] as PriceRow[];
    }
  }
  return [];
}

function toEpoch(v: string | number | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

export async function refreshWatchList(): Promise<void> {
  let rows: PriceRow[];
  try {
    const resp = await axios.get(PRICEDB_URL, { timeout: 20_000, validateStatus: () => true });
    if (resp.status !== 200) {
      logger.warn({ status: resp.status }, '[watchlist] pricedb.io non-200, keeping existing list');
      return;
    }
    rows = extractRows(resp.data);
    if (rows.length === 0) {
      logger.warn('[watchlist] pricedb.io returned no rows, keeping existing list');
      return;
    }
  } catch (e) {
    logger.warn({ err: errMessage(e) }, '[watchlist] pricedb.io fetch failed, keeping existing list');
    return;
  }

  const ranked = rows
    .filter((r) => typeof r.sku === 'string' && r.sku.length > 0)
    .sort((a, b) => toEpoch(b.last_updated) - toEpoch(a.last_updated));

  const top = ranked.slice(0, TOP_N);
  const skuSet = new Set<string>(CURRENCY_FALLBACK);
  const names: Record<string, string> = {};
  for (const r of top) {
    skuSet.add(r.sku!);
    if (r.name) names[r.sku!] = r.name;
  }
  const skus = [...skuSet];

  const doc = { updated_at: new Date().toISOString(), count: skus.length, skus };
  try {
    await writeFile(WATCH_LIST_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (e) {
    logger.warn({ err: errMessage(e) }, '[watchlist] failed to write watch-list.json, keeping in-memory only');
  }

  // refresh Redis watch set + name cache
  await loadWatchList();
  try {
    const pipe = redis.multi();
    pipe.del(NAMES_KEY);
    if (Object.keys(names).length > 0) pipe.hset(NAMES_KEY, names);
    await pipe.exec();
  } catch (e) {
    logger.debug({ err: errMessage(e) }, '[watchlist] name cache update failed');
  }

  logger.info({ count: skus.length, fromPricedb: top.length }, `[watchlist] loaded ${skus.length} SKUs from pricedb.io`);
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
