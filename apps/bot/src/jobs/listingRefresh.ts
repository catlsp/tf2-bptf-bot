import { logger } from '../lib/logger.js';
import { env } from '../config/index.js';
import { prisma, logEvent } from '../integrations/db.js';
import { redis } from '../integrations/redis.js';
import {
  createListing,
  deleteListing,
  listMyListings,
  fetchAutoprice,
  refreshKeyPrice,
  type MyListing,
} from '../integrations/bptf.js';
import { computeBuyPrice, refToKeysAndMetal, hasPriceDrifted } from '../pricing/listingPricer.js';
import { isStopped } from '../risk/emergencyStop.js';
import { sleep, round2 } from '../lib/utils.js';
import { errMessage } from '../lib/errors.js';
import { publish, nowIso } from '../events/publisher.js';
import { getSkuName } from '../watchlist/refreshWatchList.js';
import { getOrderBook } from '../orderbook/orderBook.js';

// Phase 2: maintain our BUY listings on bp.tf.
// - Runs every LISTING_REFRESH_INTERVAL_SEC.
// - For each watch-list SKU, ensure an active BUY listing at fair * (1 - BUY_DISCOUNT_PCT).
// - Hard cap MAX_LISTINGS; delete+recreate when price drifts > LISTING_PRICE_DRIFT_PCT.
// - On EMERGENCY_STOP, delete ALL our listings and stop.
//
// Disabled unless PAPER_LISTINGS=false. Never sends Steam offers (that's Phase 3,
// still guarded by PAPER_TRADING) and never attaches an inbound-offer handler.

const WATCHLIST_KEY = 'bptf:ob:watch';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startListingRefresh(): void {
  if (env.PAPER_LISTINGS) {
    logger.info('listing refresh disabled (PAPER_LISTINGS=true)');
    return;
  }

  logger.warn(
    { intervalSec: env.LISTING_REFRESH_INTERVAL_SEC, maxListings: env.MAX_LISTINGS },
    'Phase 2 listing refresh STARTING — real bp.tf BUY listings will be created',
  );

  void runOnce();
  timer = setInterval(() => void runOnce(), env.LISTING_REFRESH_INTERVAL_SEC * 1000);
}

export function stopListingRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

interface SkuMeta {
  defindex: number;
  quality: number;
  craftable: boolean;
}

function parseSkuKey(skuKey: string): SkuMeta | null {
  const parts = skuKey.split(';');
  const defindex = Number(parts[0]);
  const quality = Number(parts[1] ?? 6);
  if (!Number.isFinite(defindex) || defindex <= 0) return null;
  return { defindex, quality, craftable: !parts.includes('uncraftable') };
}

function isCurrencySku(skuKey: string): boolean {
  // Key 5021, Refined 5002, Reclaimed 5001, Scrap 5000 — never list currency.
  return /^(5021|5002|5001|5000);/.test(skuKey);
}

/**
 * Fair value for a SKU. Primary: bp.tf autoprice buy price (needs the item name,
 * which we hydrate from the pricedb name cache — watch-list SKUs carry no name).
 * Fallback: the live order-book midpoint from PR2. Returns null when neither has
 * data, so the SKU is safely skipped.
 */
async function fairValueForSku(skuKey: string, meta: SkuMeta): Promise<number | null> {
  const name = await getSkuName(skuKey);
  if (name) {
    const ap = await fetchAutoprice({ skuKey, name, quality: meta.quality });
    if (ap.buyRef && ap.buyRef > 0) return ap.buyRef;
  }
  const ob = await getOrderBook(skuKey);
  const lowSell = ob.sells[0]?.priceRef ?? null;
  const highBuy = ob.buys[0]?.priceRef ?? null;
  if (lowSell != null && highBuy != null) return round2((lowSell + highBuy) / 2);
  return lowSell ?? highBuy ?? null;
}

export async function runOnce(): Promise<void> {
  if (running) {
    logger.warn('listing refresh already running, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();

  try {
    // 1. Emergency stop → delete all and exit
    if (await isStopped()) {
      logger.warn('emergency stop active — deleting all our listings');
      await deleteAllOurListings('emergency_stop');
      return;
    }

    // 2. Refresh key price (ref↔keys conversion)
    await refreshKeyPrice();

    // 3. Reconcile DB ↔ bp.tf
    const remoteListings = await listMyListings();
    await reconcileRemoteWithDb(remoteListings);

    // 4. Watch-list from Redis
    const watchSkus = await redis.smembers(WATCHLIST_KEY);
    if (!watchSkus || watchSkus.length === 0) {
      logger.warn('watch-list empty, nothing to list');
      return;
    }

    // 5. Ensure an active BUY listing per SKU at the right price.
    // Include 'pending' so a queued (not-yet-resolved) listing isn't recreated as a
    // duplicate on the next tick before listingReconcile flips it to 'active'.
    const currentBuyListings = await prisma.ourListing.findMany({
      where: { intent: 'buy', status: { in: ['active', 'pending'] } },
    });
    const bySkuKey = new Map(currentBuyListings.map((l) => [l.skuKey, l]));

    let totalActive = currentBuyListings.length;
    let created = 0;
    let deleted = 0;
    let skipped = 0;
    let errors = 0;

    for (const skuKey of watchSkus) {
      if (isCurrencySku(skuKey)) {
        skipped++;
        continue;
      }

      const meta = parseSkuKey(skuKey);
      if (!meta) {
        skipped++;
        continue;
      }

      const fairValueRef = await fairValueForSku(skuKey, meta);
      const desiredPriceRef = computeBuyPrice(fairValueRef);
      if (!desiredPriceRef || desiredPriceRef <= 0) {
        skipped++;
        continue;
      }

      const existing = bySkuKey.get(skuKey);
      if (existing) {
        if (hasPriceDrifted(Number(existing.priceRef), desiredPriceRef)) {
          try {
            if (existing.bptfListingId) await deleteListing(existing.bptfListingId);
            await prisma.ourListing.update({ where: { id: existing.id }, data: { status: 'deleted', deletedAt: new Date() } });
            totalActive--;
            deleted++;
            bySkuKey.delete(skuKey); // fallthrough → recreate below
          } catch (e) {
            errors++;
            logger.warn({ err: errMessage(e), skuKey }, 'delete on drift failed');
            continue;
          }
        } else {
          skipped++;
          continue;
        }
      }

      if (totalActive >= env.MAX_LISTINGS) {
        logger.info({ totalActive, cap: env.MAX_LISTINGS }, 'reached MAX_LISTINGS, stopping creation');
        break;
      }

      const { keys, metal } = refToKeysAndMetal(desiredPriceRef);
      if (keys === 0 && metal === 0) {
        skipped++;
        continue;
      }

      const details = env.LISTING_DETAILS_TEMPLATE.replace('{priceRef}', String(desiredPriceRef));

      // Persist 'creating' first so a hung API call doesn't lose the row.
      const dbRow = await prisma.ourListing.create({
        data: {
          skuKey,
          intent: 'buy',
          priceRef: desiredPriceRef,
          priceKeys: keys,
          priceMetal: metal,
          fairValueRef: fairValueRef ?? 0,
          details,
          status: 'creating',
        },
      });

      const itemName = await getSkuName(skuKey);

      try {
        const result = await createListing({
          intent: 'buy',
          defindex: meta.defindex,
          quality: meta.quality,
          craftable: meta.craftable,
          itemName,
          priceKeys: keys,
          priceMetal: metal,
          details,
        });

        // Validation rejected the listing before any POST — record and move on.
        if ('skipped' in result) {
          await prisma.ourListing.update({
            where: { id: dbRow.id },
            data: { status: 'failed', errorMessage: `skipped: ${result.reason}` },
          });
          skipped++;
          continue;
        }

        // bp.tf is async — listing is queued; real id is resolved later by listingReconcile.
        await prisma.ourListing.update({
          where: { id: dbRow.id },
          data: { bptfListingId: result.bptfListingId, status: 'pending', refreshedAt: new Date() },
        });

        totalActive++;
        created++;

        await logEvent({
          type: 'listing.created',
          level: 'info',
          message: `BUY listing ${skuKey} @ ${desiredPriceRef} ref (${keys}k + ${metal}r) [queued]`,
          payload: { bptfListingId: result.bptfListingId, queued: result.queued, skuKey, priceRef: desiredPriceRef, keys, metal },
        });
        await publish({
          type: 'listing.created',
          level: 'info',
          at: nowIso(),
          payload: { skuKey, priceRef: desiredPriceRef, intent: 'buy' },
        });

        await sleep(env.BPTF_LISTING_DELAY_MS); // defensive throttle (limiter already enforces 60/min)
      } catch (e) {
        errors++;
        await prisma.ourListing.update({ where: { id: dbRow.id }, data: { status: 'failed', errorMessage: errMessage(e) } });
        logger.warn({ err: errMessage(e), skuKey }, 'createListing failed');
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.info({ created, deleted, skipped, errors, totalActive, durationMs }, 'listing refresh complete');

    await logEvent({
      type: 'listing.refresh.summary',
      level: 'info',
      message: `refresh: +${created} -${deleted} ~${skipped} err=${errors} active=${totalActive}`,
      payload: { created, deleted, skipped, errors, totalActive, durationMs },
    });
    await publish({
      type: 'listing.refresh.summary',
      level: 'info',
      at: nowIso(),
      payload: { created, deleted, skipped, errors, totalActive, durationMs },
    });
  } catch (e) {
    logger.error({ err: errMessage(e) }, 'listing refresh tick failed');
  } finally {
    running = false;
  }
}

/**
 * Reconcile: active in DB but missing on bp.tf → mark deleted (removed externally).
 */
async function reconcileRemoteWithDb(remote: MyListing[]): Promise<void> {
  const remoteIds = new Set(remote.map((l) => l.bptfListingId));
  const dbActive = await prisma.ourListing.findMany({ where: { status: 'active', bptfListingId: { not: null } } });

  for (const row of dbActive) {
    if (row.bptfListingId && !remoteIds.has(row.bptfListingId)) {
      await prisma.ourListing.update({
        where: { id: row.id },
        data: { status: 'deleted', deletedAt: new Date(), errorMessage: 'missing on remote' },
      });
      logger.warn({ skuKey: row.skuKey, bptfId: row.bptfListingId }, 'listing missing on bp.tf, marked deleted');
    }
  }
}

export async function deleteAllOurListings(reason: string): Promise<void> {
  const active = await prisma.ourListing.findMany({ where: { status: 'active', bptfListingId: { not: null } } });
  for (const row of active) {
    try {
      if (row.bptfListingId) await deleteListing(row.bptfListingId);
      await prisma.ourListing.update({ where: { id: row.id }, data: { status: 'deleted', deletedAt: new Date(), errorMessage: reason } });
    } catch (e) {
      logger.warn({ err: errMessage(e), skuKey: row.skuKey }, 'failed to delete listing during emergency');
    }
  }
}
