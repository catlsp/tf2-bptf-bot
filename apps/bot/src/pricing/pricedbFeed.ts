import axios from 'axios';
import { errMessage } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// Single source of truth for talking to pricedb.io's priced feed. Both the watch
// list builder (which SKUs to track) and the price oracle (what they're worth)
// consume this, so the fetch/parse/validation lives in exactly one place.
//
// Feed shape (array of rows, or a single row from the per-item endpoint):
//   { "name": "...", "sku": "5021;6", "source": "bptf", "time": 1781007393,
//     "buy": {"keys":0,"metal":55.55}, "sell": {"keys":0,"metal":56.66} }
//
// Two endpoints, two jobs:
//   GET /api/prices       → the 100 most-recently-priced items (a rotating
//                           window). Used by the watch-list builder to discover
//                           cheap, liquid SKUs to track.
//   GET /api/item/{sku}   → the authoritative current price for ONE sku. Used by
//                           the price oracle to price exactly the watch set,
//                           since /api/prices is too sparse/volatile to cover it.

const PRICEDB_BASE = 'https://pricedb.io/api';
export const PRICEDB_URL = `${PRICEDB_BASE}/prices`;

export interface PricedbCurrency {
  keys?: number;
  metal?: number;
}

export interface PricedbRow {
  sku?: string;
  name?: string;
  source?: string;
  /** Unix seconds the price was last updated. */
  time?: number;
  buy?: PricedbCurrency;
  sell?: PricedbCurrency;
}

/** Dig the row array out of whichever envelope pricedb returns. */
function extractRows(data: unknown): PricedbRow[] {
  if (Array.isArray(data)) return data as PricedbRow[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of ['items', 'prices', 'data', 'results']) {
      if (Array.isArray(obj[k])) return obj[k] as PricedbRow[];
    }
  }
  return [];
}

/**
 * Fetch the pricedb.io priced feed. Returns an empty array (never throws) on any
 * network/parse failure or non-200, so callers can fall back to their last-good
 * state instead of clobbering it.
 */
export async function fetchPricedbRows(): Promise<PricedbRow[]> {
  try {
    const resp = await axios.get(PRICEDB_URL, { timeout: 20_000, validateStatus: () => true });
    if (resp.status !== 200) {
      logger.warn({ status: resp.status }, '[pricedb] non-200 from feed');
      return [];
    }
    const rows = extractRows(resp.data);
    if (rows.length === 0) logger.warn('[pricedb] feed returned no rows');
    return rows;
  } catch (e) {
    logger.warn({ err: errMessage(e) }, '[pricedb] feed fetch failed');
    return [];
  }
}

/**
 * Fetch the authoritative current price for a single SKU from /api/item/{sku}.
 * Returns the row, or null on any non-200 / unknown-item / network failure (the
 * oracle treats null as "no reference price" and skips trading that SKU).
 */
export async function fetchPricedbItem(sku: string): Promise<PricedbRow | null> {
  try {
    const resp = await axios.get(`${PRICEDB_BASE}/item/${encodeURIComponent(sku)}`, {
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (resp.status !== 200) return null;
    const row = resp.data as PricedbRow;
    if (!row || typeof row !== 'object' || typeof row.sku !== 'string') return null;
    return row;
  } catch (e) {
    logger.debug({ err: errMessage(e), sku }, '[pricedb] item fetch failed');
    return null;
  }
}
