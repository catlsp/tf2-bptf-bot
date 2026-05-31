import type { SkuRef } from '../pricing/fairValue.js';
import { prisma } from '../integrations/db.js';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { getSeedWatchlist } from './seed.js';
import { defindexFromSkuKey } from '../lib/utils.js';
import { getWatchedSkus } from '../orderbook/orderBook.js';
import { getSkuName } from './refreshWatchList.js';
import { parseSku } from '../util/itemToSku.js';

// Runtime watchlist. On first boot we persist the seed; thereafter the active
// rows in WatchlistEntry are the source of truth so /watchlist edits and the
// Phase 7 auto-expander survive restarts.

export async function ensureSeeded(): Promise<void> {
  const count = await prisma.watchlistEntry.count();
  if (count > 0) return;
  const seeds = getSeedWatchlist(env.WATCHLIST_SEED_SIZE);
  await prisma.watchlistEntry.createMany({
    data: seeds.map((s) => ({ skuKey: s.skuKey, maxBuyRef: 9999, active: true })),
    skipDuplicates: true,
  });
  logger.info({ seeded: seeds.length }, 'watchlist seeded');
}

/**
 * Active SKUs to scan. Primary source is the dynamic order-book watch set
 * (pricedb.io top-liquid, loaded into Redis). Names are hydrated from the pricedb
 * name cache; quality/craftable are parsed from the SKU. Falls back to the DB
 * seed list if the watch set is empty (e.g. Redis cold / pricedb down at boot).
 */
export async function getActiveWatchlist(): Promise<SkuRef[]> {
  const watched = await getWatchedSkus().catch(() => [] as string[]);
  if (watched.length > 0) {
    const seedByKey = new Map(getSeedWatchlist(1000).map((s) => [s.skuKey, s]));
    return Promise.all(
      watched.map(async (sku): Promise<SkuRef> => {
        const seed = seedByKey.get(sku);
        if (seed) return seed;
        const { quality, craftable } = parseSku(sku);
        const name = (await getSkuName(sku)) ?? `defindex ${defindexFromSkuKey(sku)}`;
        return { skuKey: sku, name, quality, craftable };
      }),
    );
  }

  // fallback: Phase 1 DB seed
  const rows = await prisma.watchlistEntry.findMany({ where: { active: true }, orderBy: { priority: 'desc' } });
  const seedByKey = new Map(getSeedWatchlist(1000).map((s) => [s.skuKey, s]));
  return rows.map((r) => {
    const seed = seedByKey.get(r.skuKey);
    if (seed) return seed;
    const { quality, craftable } = parseSku(r.skuKey);
    return { skuKey: r.skuKey, name: r.notes ?? `defindex ${defindexFromSkuKey(r.skuKey)}`, quality, craftable };
  });
}

export async function addToWatchlist(skuKey: string, maxBuyRef: number, notes?: string): Promise<void> {
  await prisma.watchlistEntry.upsert({
    where: { skuKey },
    create: { skuKey, maxBuyRef, notes, active: true },
    update: { active: true, maxBuyRef, notes },
  });
}

export async function removeFromWatchlist(skuKey: string): Promise<void> {
  await prisma.watchlistEntry.updateMany({ where: { skuKey }, data: { active: false } });
}
