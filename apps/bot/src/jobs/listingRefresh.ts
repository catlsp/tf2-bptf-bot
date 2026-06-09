import { logger } from '../lib/logger.js';
import { env } from '../config/index.js';
import { prisma, logEvent } from '../integrations/db.js';
import { redis } from '../integrations/redis.js';
import {
  createListing,
  deleteListing,
  updateListingPrice,
  listMyListings,
  fetchAutoprice,
  refreshKeyPrice,
  currentKeyRef,
  type MyListing,
} from '../integrations/bptf.js';
import { refToKeysAndMetal, hasPriceDrifted, quantizeForDisplay } from '../pricing/listingPricer.js';
import {
  evaluateListingBuyPrice,
  evaluateListingSellPrice,
  priceCompetitiveBuy,
  priceCompetitiveSell,
  type ListingMarket,
} from '../pricing/strategy.js';
import {
  getOwnedListableItems,
  markListed,
  type OwnedItem,
} from '../inventory/inventoryService.js';
import { safeLoadMetal } from '../integrations/steam.js';
import { isStopped } from '../risk/emergencyStop.js';
import { sleep, round2 } from '../lib/utils.js';
import { errMessage } from '../lib/errors.js';
import { publish, nowIso } from '../events/publisher.js';
import { getSkuName } from '../watchlist/refreshWatchList.js';
import { getOrderBook } from '../orderbook/orderBook.js';
import { getRefPrice } from '../pricing/priceOracle.js';
import {
  loadOverrides,
  getOverride,
  isSkuActive,
  effectiveCap,
  effectiveRefBuy,
  effectiveRefSell,
} from '../watchlist/overrides.js';
import { openPositionForSku } from '../risk/limits.js';

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

// Listing descriptions carry the item name + price so the classified reads like
// "Buying <item> for <price> ref" instead of an anonymous price. itemName may be
// null when the pricedb name cache is cold — fall back to a neutral phrase.
function buyDetails(itemName: string | null, displayedTotal: number, held: number, cap: number): string {
  return env.LISTING_DETAILS_TEMPLATE.replace('{itemName}', itemName ?? 'this item')
    .replace('{priceRef}', String(displayedTotal))
    .replace('{held}', String(held))
    .replace('{cap}', String(cap));
}

function sellDetails(itemName: string | null, displayedTotal: number): string {
  return `Selling ${itemName ?? 'this item'} for ${displayedTotal} ref. Send a trade offer.`;
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

    // 2. Refresh key price (ref↔keys conversion) + per-SKU overrides
    await refreshKeyPrice();
    await loadOverrides();

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
    let updated = 0;
    let deleted = 0;
    let skipped = 0;
    let errors = 0;
    let sellCreated = 0;
    let sellUpdated = 0;

    // Market-making BUYs must be funded by liquid metal we actually hold. Compute
    // the spendable refined once (reserve held back). Arbitrage mode is ungated.
    let availableRef = Infinity;
    if (env.STRATEGY_MODE === 'market_making') {
      const counts = await safeLoadMetal();
      availableRef = round2(Math.max(0, counts.refinedTotal - env.TF2VAULT_RESERVE_REFINED));
    }

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

      // Per-SKU control (Watchlist panel): pause + position cap apply to every
      // strategy mode. held/cap also feed the listing description ("0/1").
      const ovr = getOverride(skuKey);
      if (!isSkuActive(ovr)) {
        skipped++;
        continue;
      }
      const cap = effectiveCap(ovr, env.MAX_POSITION_PER_SKU);
      const held = await openPositionForSku(skuKey);
      if (held >= cap) {
        // already holding/listing the max we want of this SKU
        skipped++;
        continue;
      }

      let desiredPriceRef: number | null;
      let fairValueRef: number;
      if (env.STRATEGY_MODE === 'market_making') {
        // Price off pricedb (the real market level), not the incomplete WS book.
        // No pricedb reference → no BUY listing.
        const ref = getRefPrice(skuKey);
        if (!ref) {
          skipped++;
          continue;
        }
        desiredPriceRef = priceCompetitiveBuy({
          refBuyRef: effectiveRefBuy(ref.buyRef, ovr),
          refSellRef: effectiveRefSell(ref.sellRef, ovr),
          maxBuyCapRef: env.WATCH_MAX_BUY_REF,
          minSpreadScrap: env.MM_MIN_SPREAD_SCRAP,
        });
        fairValueRef = round2((ref.buyRef + ref.sellRef) / 2);
        // Balance gate: only bid what we can actually fund. Not an error — the
        // natural state until a sale tops the wallet back up.
        if (desiredPriceRef != null && availableRef < desiredPriceRef) {
          logger.warn(
            { skuKey, desiredPriceRef, availableRef },
            'insufficient funds for BUY listing — skipping (will retry once balance recovers)',
          );
          skipped++;
          continue;
        }
      } else {
        const market = await buildMarketSnapshot(skuKey, meta);
        desiredPriceRef = market ? evaluateListingBuyPrice({ skuKey, market }) : null;
        fairValueRef = market?.fairValueRef ?? 0;
      }
      if (!desiredPriceRef || desiredPriceRef <= 0) {
        // No book to anchor on, not competitive, or dust — don't spam a dead listing.
        skipped++;
        continue;
      }

      const existing = bySkuKey.get(skuKey);
      if (existing) {
        if (hasPriceDrifted(Number(existing.priceRef), desiredPriceRef)) {
          // v2: update price in place (PATCH) rather than delete+recreate.
          const { keys, metal } = refToKeysAndMetal(desiredPriceRef);
          const displayedTotal = round2(keys * currentKeyRef() + quantizeForDisplay(metal));
          const itemName = await getSkuName(skuKey);
          const details = buyDetails(itemName, displayedTotal, held, cap);
          try {
            if (existing.bptfListingId) {
              await updateListingPrice(existing.bptfListingId, keys, metal, details);
            } else {
              logger.warn({ skuKey, id: existing.id }, 'drift: missing bptfListingId — patching local row only');
            }
            await prisma.ourListing.update({
              where: { id: existing.id },
              data: { priceRef: desiredPriceRef, priceKeys: keys, priceMetal: metal, details, refreshedAt: new Date() },
            });
            updated++;
          } catch (e) {
            errors++;
            logger.warn({ err: errMessage(e), skuKey }, 'patch on drift failed');
          }
        } else {
          skipped++;
        }
        continue; // PATCH in place — never fall through to create a duplicate
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
      const itemName = await getSkuName(skuKey);
      const details = buyDetails(itemName, displayedTotal, held, cap);

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

        // v2 create is synchronous: a real id means 'active' immediately. A null id
        // (legacy/queued path or a mock) stays 'pending' for listingReconcile.
        await prisma.ourListing.update({
          where: { id: dbRow.id },
          data: {
            bptfListingId: result.bptfListingId,
            status: result.bptfListingId ? 'active' : 'pending',
            refreshedAt: new Date(),
          },
        });

        totalActive++;
        created++;

        await logEvent({
          type: 'listing.created',
          level: 'info',
          message: `BUY listing ${skuKey} @ ${desiredPriceRef} ref (${keys}k + ${metal}r)`,
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
      { created, updated, deleted, skipped, errors, sellCreated, sellUpdated, totalActive, durationMs },
      'listing refresh complete',
    );

    await logEvent({
      type: 'listing.refresh.summary',
      level: 'info',
      message: `refresh: +${created} ^${updated} -${deleted} ~${skipped} err=${errors} active=${totalActive} sell:+${sellCreated}~${sellUpdated}`,
      payload: { created, updated, deleted, skipped, errors, sellCreated, sellUpdated, totalActive, durationMs },
    });
    await publish({
      type: 'listing.refresh.summary',
      level: 'info',
      at: nowIso(),
      payload: { created, updated, deleted, skipped, errors, sellCreated, sellUpdated, totalActive, durationMs },
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

    // Resolve a per-item SELL price + a fair value for the row, by strategy mode.
    // market_making prices each asset against its own cost basis (acquiredPriceRef);
    // arbitrage prices the whole SKU once off the market snapshot.
    let priceFor: (item: OwnedItem) => number | null;
    let fairValueRef: number;
    if (env.STRATEGY_MODE === 'market_making') {
      // Per-SKU pause from the panel applies to selling too.
      const ovr = getOverride(skuKey);
      if (!isSkuActive(ovr)) continue;
      // Price off pricedb sell (the real market level); no reference → don't list.
      const ref = getRefPrice(skuKey);
      if (!ref) continue;
      const refSellRef = effectiveRefSell(ref.sellRef, ovr);
      fairValueRef = refSellRef;
      priceFor = (item) => priceCompetitiveSell(refSellRef, item.acquiredPriceRef, env.MM_MIN_SPREAD_SCRAP);
    } else {
      const market = await buildMarketSnapshot(skuKey, meta);
      if (!market) continue;
      fairValueRef = market.fairValueRef;
      const skuPrice = evaluateListingSellPrice({ skuKey, market });
      priceFor = () => skuPrice;
    }

    for (const ownedItem of items) {
      const desiredPriceRef = priceFor(ownedItem);
      if (!desiredPriceRef) {
        logger.debug({ skuKey, itemId: ownedItem.itemId }, 'sell evaluator returned null');
        continue;
      }
      const existing = sellByItemId.get(ownedItem.itemId);
      try {
        if (existing) {
          if (hasPriceDrifted(existing.priceRef, desiredPriceRef)) {
            await patchSellListing(existing, skuKey, desiredPriceRef);
            updated++;
          }
        } else {
          const row = await createSellListing({ skuKey, meta, item: ownedItem, priceRef: desiredPriceRef, fairValueRef });
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

/** PATCH an existing SELL listing's price in place (v2), updating the local row. */
async function patchSellListing(
  existing: { id: string; bptfListingId: string | null },
  skuKey: string,
  priceRef: number,
): Promise<void> {
  const { keys, metal } = refToKeysAndMetal(priceRef);
  const displayedTotal = round2(keys * currentKeyRef() + quantizeForDisplay(metal));
  const itemName = await getSkuName(skuKey);
  const details = sellDetails(itemName, displayedTotal);
  if (existing.bptfListingId) {
    await updateListingPrice(existing.bptfListingId, keys, metal, details);
  } else {
    logger.warn({ skuKey, listingId: existing.id }, 'sell drift: missing bptfListingId — patching local row only');
  }
  await prisma.listing.update({ where: { id: existing.id }, data: { priceRef: displayedTotal } });
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
  fairValueRef: number;
}): Promise<{ id: string } | null> {
  const { skuKey, meta, item, priceRef, fairValueRef } = args;

  const { keys, metal } = refToKeysAndMetal(priceRef);
  const displayedTotal = round2(keys * currentKeyRef() + quantizeForDisplay(metal));
  const itemName = await getSkuName(skuKey);
  const details = sellDetails(itemName, displayedTotal);

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

  // v2 create is synchronous: bptfListingId is the real id (or null in a mock).
  const row = await prisma.listing.create({
    data: {
      bptfListingId: result.bptfListingId,
      itemId: item.itemId,
      intent: 'SELL',
      priceRef: displayedTotal,
      fairValueRef,
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
