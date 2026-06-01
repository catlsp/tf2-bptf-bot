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
  currentKeyRef,
  type MyListing,
} from '../integrations/bptf.js';
import { refToKeysAndMetal, hasPriceDrifted, quantizeForDisplay } from '../pricing/listingPricer.js';
import { evaluateListingBuyPrice, evaluateListingSellPrice, type ListingMarket } from '../pricing/strategy.js';
import {
  getOwnedListableItems,
  markListed,
  type OwnedItem,
} from '../inventory/inventoryService.js';
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

export interface SkuMeta {
  defindex: number;
  quality: number;
  craftable: boolean;
}

export function parseSkuKey(skuKey: string): SkuMeta | null {
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
 * Build the market snapshot a listing is priced from: fair value plus the live
 * sell floor and best buy order.
 *
 * Smart autoprice (trending-market protection): the bp.tf autoprice buy price is
 * the primary fair value, but in a falling market it lags. If the live sell floor
 * has dropped more than STALE_AUTOPRICE_PCT below autoprice, we treat autoprice
 * as stale and blend toward the live floor (LIVE_MARKET_WEIGHT) so we don't
 * overpay on a buy anchored to a stale price.
 *
 * Fallbacks (no usable autoprice): order-book midpoint, then whichever side
 * exists. Returns null when there's no fair value at all, so the SKU is skipped.
 */
export async function buildMarketSnapshot(skuKey: string, meta: SkuMeta): Promise<ListingMarket | null> {
  const name = await getSkuName(skuKey);
  let autopriceBuy: number | null = null;
  if (name) {
    const ap = await fetchAutoprice({ skuKey, name, quality: meta.quality });
    if (ap.buyRef && ap.buyRef > 0) autopriceBuy = ap.buyRef;
  }

  const ob = await getOrderBook(skuKey);
  const lowestSellRef = ob.sells[0]?.priceRef ?? null;
  const highestBuyRef = ob.buys[0]?.priceRef ?? null;

  let fairValueRef: number | null = null;
  if (autopriceBuy != null && lowestSellRef != null) {
    const staleThreshold = autopriceBuy * (1 - env.STALE_AUTOPRICE_PCT / 100);
    if (lowestSellRef < staleThreshold) {
      const w = env.LIVE_MARKET_WEIGHT;
      fairValueRef = round2(lowestSellRef * w + autopriceBuy * (1 - w));
      logger.info(
        { skuKey, autopriceBuy, lowestSellRef, blendedFv: fairValueRef },
        'stale autoprice detected, using blended fair value',
      );
    } else {
      fairValueRef = autopriceBuy;
    }
  } else if (autopriceBuy != null) {
    fairValueRef = autopriceBuy;
  } else if (lowestSellRef != null && highestBuyRef != null) {
    fairValueRef = round2((lowestSellRef + highestBuyRef) / 2);
  } else {
    fairValueRef = lowestSellRef ?? highestBuyRef ?? null;
  }

  if (fairValueRef == null) return null;
  return { fairValueRef, lowestSellRef, highestBuyRef };
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
    let sellCreated = 0;
    let sellUpdated = 0;

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

      const market = await buildMarketSnapshot(skuKey, meta);
      const desiredPriceRef = market ? evaluateListingBuyPrice({ skuKey, market }) : null;
      if (!desiredPriceRef || desiredPriceRef <= 0) {
        // No sell-side market, not competitive, or dust — don't spam a dead listing.
        skipped++;
        continue;
      }
      const fairValueRef = market!.fairValueRef;

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

      // Render the description with the value bp.tf will actually DISPLAY, so the
      // text matches the price card. metal is already on the scrap grid, but the
      // displayed total folds keys back in via the current key price.
      const displayedTotal = round2(keys * currentKeyRef() + quantizeForDisplay(metal));
      const details = env.LISTING_DETAILS_TEMPLATE.replace('{priceRef}', String(displayedTotal));

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

    // 6. SELL listings for items we own (InventoryItem HELD → bp.tf SELL).
    // Uses the Listing model (OurListing is BUY-only by convention).
    const sellResult = await refreshSellListings();
    sellCreated = sellResult.created;
    sellUpdated = sellResult.updated;
    errors += sellResult.errors;

    const durationMs = Date.now() - startedAt;
    logger.info(
      { created, deleted, skipped, errors, sellCreated, sellUpdated, totalActive, durationMs },
      'listing refresh complete',
    );

    await logEvent({
      type: 'listing.refresh.summary',
      level: 'info',
      message: `refresh: +${created} -${deleted} ~${skipped} err=${errors} active=${totalActive} sell:+${sellCreated}~${sellUpdated}`,
      payload: { created, deleted, skipped, errors, sellCreated, sellUpdated, totalActive, durationMs },
    });
    await publish({
      type: 'listing.refresh.summary',
      level: 'info',
      at: nowIso(),
      payload: { created, deleted, skipped, errors, sellCreated, sellUpdated, totalActive, durationMs },
    });
  } catch (e) {
    logger.error({ err: errMessage(e) }, 'listing refresh tick failed');
  } finally {
    running = false;
  }
}

/**
 * SELL side: list items we own (InventoryItem HELD) on bp.tf. Prices each owned
 * SKU once, then ensures one SELL Listing row per owned asset, recreating on
 * price drift. Returns counters folded into the refresh summary.
 */
async function refreshSellListings(): Promise<{ created: number; updated: number; errors: number }> {
  let created = 0;
  let updated = 0;
  let errors = 0;

  const ownedItems = await getOwnedListableItems();
  if (ownedItems.length === 0) return { created, updated, errors };

  const activeSellListings = await prisma.listing.findMany({ where: { intent: 'SELL', active: true } });
  const sellByItemId = new Map(activeSellListings.map((l) => [l.itemId, l]));

  // Group owned items by skuKey so we price each SKU once, not per asset.
  const ownedBySku = new Map<string, OwnedItem[]>();
  for (const item of ownedItems) {
    const arr = ownedBySku.get(item.skuKey) ?? [];
    arr.push(item);
    ownedBySku.set(item.skuKey, arr);
  }

  for (const [skuKey, items] of ownedBySku) {
    if (isCurrencySku(skuKey)) continue;
    const meta = parseSkuKey(skuKey);
    if (!meta) continue;

    const market = await buildMarketSnapshot(skuKey, meta);
    if (!market) continue;
    const desiredPriceRef = evaluateListingSellPrice({ skuKey, market });
    if (!desiredPriceRef) {
      logger.debug({ skuKey, market }, 'sell evaluator returned null');
      continue;
    }

    for (const ownedItem of items) {
      const existing = sellByItemId.get(ownedItem.itemId);
      try {
        if (existing) {
          if (hasPriceDrifted(existing.priceRef, desiredPriceRef)) {
            if (existing.bptfListingId) await deleteListing(existing.bptfListingId);
            await prisma.listing.update({
              where: { id: existing.id },
              data: { active: false, closedAt: new Date(), closedReason: 'price_drift' },
            });
            const row = await createSellListing({ skuKey, meta, item: ownedItem, priceRef: desiredPriceRef, market });
            if (row) {
              await markListed(ownedItem.inventoryItemId, row.id);
              updated++;
            }
          }
        } else {
          const row = await createSellListing({ skuKey, meta, item: ownedItem, priceRef: desiredPriceRef, market });
          if (row) {
            await markListed(ownedItem.inventoryItemId, row.id);
            created++;
          }
        }
      } catch (e) {
        errors++;
        logger.error({ err: errMessage(e), skuKey, itemId: ownedItem.itemId }, 'sell listing refresh failed');
      }
    }
  }

  return { created, updated, errors };
}

/**
 * Create one SELL listing on bp.tf for an owned asset and persist a Listing row.
 * Reuses the same bp.tf client as BUY (it already supports intent='sell' +
 * assetId) and the same scrap-grid display sync. Returns null if bp.tf validation
 * skipped the listing (e.g. missing item name).
 */
async function createSellListing(args: {
  skuKey: string;
  meta: SkuMeta;
  item: OwnedItem;
  priceRef: number;
  market: ListingMarket;
}): Promise<{ id: string } | null> {
  const { skuKey, meta, item, priceRef, market } = args;

  const { keys, metal } = refToKeysAndMetal(priceRef);
  const displayedTotal = round2(keys * currentKeyRef() + quantizeForDisplay(metal));
  const details = `Selling for ${displayedTotal} ref. Send a trade offer.`;
  const itemName = await getSkuName(skuKey);

  const result = await createListing({
    intent: 'sell',
    defindex: meta.defindex,
    quality: meta.quality,
    craftable: meta.craftable,
    itemName,
    priceKeys: keys,
    priceMetal: metal,
    details,
    assetId: item.assetId, // critical: makes it a real sell listing on bp.tf
  });

  if ('skipped' in result) {
    logger.warn({ skuKey, itemId: item.itemId, reason: result.reason }, 'sell listing skipped by validation');
    return null;
  }

  // bp.tf is async — bptfListingId resolves later; store what we have.
  const row = await prisma.listing.create({
    data: {
      bptfListingId: result.bptfListingId,
      itemId: item.itemId,
      intent: 'SELL',
      priceRef: displayedTotal,
      fairValueRef: market.fairValueRef,
      active: true,
    },
  });
  logger.info(
    { skuKey, itemId: item.itemId, priceRef: displayedTotal, listingId: row.id },
    'sell listing created',
  );
  return { id: row.id };
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
