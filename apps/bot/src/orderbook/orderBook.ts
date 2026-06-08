import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { redis } from '../integrations/redis.js';
import { currentKeyRef } from '../integrations/bptf.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { round2 } from '../lib/utils.js';
import { itemToSku } from '../util/itemToSku.js';

// Redis-backed order book fed by the bp.tf WebSocket stream.
//
// Key schema:
//   bptf:ob:watch                     SET   active SKUs (from watch-list.json)
//   bptf:ob:<sku>:buys                ZSET  member=listing_id  score=refined
//   bptf:ob:<sku>:sells               ZSET  member=listing_id  score=refined
//   bptf:ob:listing:<listing_id>      HASH  details + raw_json, TTL 30m

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WATCH_LIST_PATH = resolve(__dirname, '../../config/watch-list.json');

const WATCH_KEY = 'bptf:ob:watch';
const LISTING_TTL_SEC = 30 * 60;
const TOP_N = 50;

const buysKey = (sku: string) => `bptf:ob:${sku}:buys`;
const sellsKey = (sku: string) => `bptf:ob:${sku}:sells`;
const listingKey = (id: string) => `bptf:ob:listing:${id}`;

export interface WsListingPayload {
  id: string;
  steamid?: string;
  item?: unknown;
  // bp.tf's v2 events stream sends intent as the STRING 'buy' | 'sell'. Older/
  // alternate shapes used the numbers 0 (buy) / 1 (sell), so we accept both.
  intent?: number | string;
  appid?: number;
  currencies?: { keys?: number; metal?: number };
  bumpedAt?: number;
  [k: string]: unknown;
}

/**
 * Normalize a listing's intent to 'buy' | 'sell'. bp.tf v2 sends the string
 * 'sell'; legacy numeric payloads used 1 for sell. Anything else is a buy.
 *
 * This was THE order-book accuracy bug: when intent arrived as 'sell' (string),
 * the old `=== 1` check failed, so every sell listing was filed as a buy —
 * emptying the sell side and polluting the buy side, which corrupted every price
 * derived from the book (and in turn our listing prices).
 */
export function parseIntent(raw: number | string | undefined): 'buy' | 'sell' {
  return raw === 'sell' || raw === 1 ? 'sell' : 'buy';
}

export interface OrderBookEntry {
  listingId: string;
  steamId: string;
  priceRef: number;
  bumpedAt?: number;
}

// --- in-memory replay buffer for when Redis is briefly unavailable ---
const BUFFER_MAX = 100;
const buffer: WsListingPayload[] = [];
let replayScheduled = false;

function redisReady(): boolean {
  return redis.status === 'ready';
}

function bufferEvent(payload: WsListingPayload): void {
  buffer.push(payload);
  if (buffer.length > BUFFER_MAX) buffer.shift();
}

export function initOrderBook(): void {
  redis.on('ready', () => {
    if (buffer.length === 0 || replayScheduled) return;
    replayScheduled = true;
    const pending = buffer.splice(0, buffer.length);
    logger.info({ count: pending.length }, '[ob] redis ready, replaying buffered events');
    void (async () => {
      for (const p of pending) await applyUpdate(p).catch(() => {});
      replayScheduled = false;
    })();
  });
}

/** Load config/watch-list.json into the watch SET (replacing the old contents). */
export async function loadWatchList(): Promise<number> {
  const raw = await readFile(WATCH_LIST_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { skus?: string[] };
  const skus = Array.isArray(parsed.skus) ? parsed.skus.filter((s) => typeof s === 'string' && s.length > 0) : [];
  const pipe = redis.multi();
  pipe.del(WATCH_KEY);
  if (skus.length > 0) pipe.sadd(WATCH_KEY, ...skus);
  await pipe.exec();
  logger.info({ count: skus.length }, '[watchlist] loaded SKUs into order book watch set');
  return skus.length;
}

export async function getWatchedSkus(): Promise<string[]> {
  return redis.smembers(WATCH_KEY);
}

/** Add/update a listing. Drops anything not on the watch list. */
export async function applyUpdate(payload: WsListingPayload): Promise<void> {
  if (!redisReady()) {
    bufferEvent(payload);
    return;
  }

  const sku = itemToSku(payload.item);

  if ((await redis.sismember(WATCH_KEY, sku)) !== 1) {
    logger.debug({ sku }, '[ob] drop: not on watch list');
    return;
  }

  const keyRef = currentKeyRef();
  const keys = payload.currencies?.keys ?? 0;
  const metal = payload.currencies?.metal ?? 0;
  const refinedTotal = round2(keys * keyRef + metal);
  if (refinedTotal <= 0) {
    logger.debug({ sku, id: payload.id }, '[ob] drop: non-positive price');
    return;
  }

  const intent = parseIntent(payload.intent);
  const id = payload.id;
  const zKey = intent === 'sell' ? sellsKey(sku) : buysKey(sku);
  const oppKey = intent === 'sell' ? buysKey(sku) : sellsKey(sku);

  const pipe = redis.multi();
  pipe.zrem(oppKey, id); // guard against an intent flip leaving a stale member
  pipe.hset(listingKey(id), {
    sku,
    intent,
    steamid: payload.steamid ?? '',
    keys: String(keys),
    metal: String(metal),
    refined_total: String(refinedTotal),
    bumped_at: String(payload.bumpedAt ?? Date.now()),
    raw_json: JSON.stringify(payload),
  });
  pipe.expire(listingKey(id), LISTING_TTL_SEC);
  pipe.zadd(zKey, refinedTotal, id);
  await pipe.exec();

  logger.debug({ sku, intent, refined: refinedTotal, id }, `[ob] applyUpdate: ${sku} ${intent} @ ${keys}k+${metal}`);
}

/** Remove a listing from its ZSET and delete the HASH. */
export async function applyDelete(listingId: string): Promise<void> {
  if (!redisReady()) return;
  const key = listingKey(listingId);
  const data = await redis.hmget(key, 'sku', 'intent');
  const sku = data[0];
  const intent = data[1];
  const pipe = redis.multi();
  if (sku) {
    pipe.zrem(intent === 'sell' ? sellsKey(sku) : buysKey(sku), listingId);
  } else {
    // HASH already gone (TTL); we can't know the sku, so this is a best-effort no-op.
    logger.debug({ listingId }, '[ob] applyDelete: hash missing, nothing to unlink');
  }
  pipe.del(key);
  await pipe.exec();
  logger.debug({ listingId, sku }, '[ob] applyDelete');
}

async function hydrate(ids: string[]): Promise<Map<string, OrderBookEntry>> {
  const map = new Map<string, OrderBookEntry>();
  if (ids.length === 0) return map;
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hmget(listingKey(id), 'steamid', 'refined_total', 'bumped_at');
  const res = await pipe.exec();
  res?.forEach((entry, i) => {
    const id = ids[i]!;
    const fields = entry?.[1] as (string | null)[] | undefined;
    if (!fields || fields[1] == null) return; // HASH expired -> skip (pruned by caller)
    map.set(id, {
      listingId: id,
      steamId: fields[0] ?? '',
      priceRef: Number(fields[1]),
      bumpedAt: fields[2] ? Number(fields[2]) : undefined,
    });
  });
  return map;
}

/** Top-N buys (highest first) and sells (lowest first) for a SKU. Prunes dead members. */
export async function getOrderBook(sku: string): Promise<{ buys: OrderBookEntry[]; sells: OrderBookEntry[] }> {
  if (!redisReady()) return { buys: [], sells: [] };

  const [buyIds, sellIds] = await Promise.all([
    redis.zrevrange(buysKey(sku), 0, TOP_N - 1), // highest buy first
    redis.zrange(sellsKey(sku), 0, TOP_N - 1), // lowest sell first
  ]);

  const hydrated = await hydrate([...buyIds, ...sellIds]);

  const collect = async (ids: string[], zKey: string): Promise<OrderBookEntry[]> => {
    const out: OrderBookEntry[] = [];
    const stale: string[] = [];
    for (const id of ids) {
      const e = hydrated.get(id);
      if (e) out.push(e);
      else stale.push(id);
    }
    if (stale.length > 0) await redis.zrem(zKey, ...stale).catch(() => {});
    return out;
  };

  const [buys, sells] = await Promise.all([collect(buyIds, buysKey(sku)), collect(sellIds, sellsKey(sku))]);
  return { buys, sells };
}

export interface OrderBookStats {
  totalListings: number;
  totalSkus: number;
  memoryUsedMB: number;
}

export async function getStats(): Promise<OrderBookStats> {
  let totalListings = 0;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'bptf:ob:listing:*', 'COUNT', 500);
      cursor = next;
      totalListings += keys.length;
    } while (cursor !== '0');
  } catch (e) {
    logger.debug({ err: errMessage(e) }, '[ob] stats scan failed');
  }

  let memoryUsedMB = 0;
  try {
    const info = await redis.info('memory');
    const m = /used_memory:(\d+)/.exec(info);
    if (m) memoryUsedMB = round2(Number(m[1]) / 1024 / 1024);
  } catch {
    /* ignore */
  }

  const totalSkus = await redis.scard(WATCH_KEY).catch(() => 0);
  return { totalListings, totalSkus, memoryUsedMB };
}
