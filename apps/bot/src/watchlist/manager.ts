import type { SkuRef } from '../pricing/fairValue.js';
import { prisma } from '../integrations/db.js';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { getSeedWatchlist } from './seed.js';
import { defindexFromSkuKey } from '../lib/utils.js';

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
 * Active SKUs to scan. We hydrate name/quality/craftable from the seed catalog
 * when available, falling back to defindex-derived fields for runtime-added rows.
 */
export async function getActiveWatchlist(): Promise<SkuRef[]> {
  const rows = await prisma.watchlistEntry.findMany({
    where: { active: true },
    orderBy: { priority: 'desc' },
  });
  const seedByKey = new Map(getSeedWatchlist(1000).map((s) => [s.skuKey, s]));
  return rows.map((r) => {
    const seed = seedByKey.get(r.skuKey);
    if (seed) return seed;
    const parts = r.skuKey.split(';');
    return {
      skuKey: r.skuKey,
      name: r.notes ?? `defindex ${defindexFromSkuKey(r.skuKey)}`,
      quality: Number(parts[1] ?? 6),
      craftable: !parts.includes('uncraftable'),
    };
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
