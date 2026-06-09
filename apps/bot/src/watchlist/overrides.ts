import { prisma } from '../integrations/db.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';

// Per-SKU control layer. The Watchlist panel page writes WatchlistEntry rows that
// OVERRIDE the bot's defaults for a specific SKU: pause it, cap the bid, set a
// minimum sell, or limit how many we hold. The bot still discovers SKUs from the
// pricedb watch set; these rows just steer what it does with them.
//
// A SKU with no entry uses defaults: active, no extra price cap, global position
// cap (MAX_POSITION_PER_SKU). The cache is reloaded once per listing-refresh tick.

export interface SkuOverride {
  active: boolean;
  /** Per-SKU bid ceiling in ref (an extra cap on top of the pricedb rail). */
  maxBuyRef: number;
  /** Per-SKU sell floor in ref; null = no extra floor beyond the pricedb rail. */
  minSellRef: number | null;
  /** Per-SKU position cap; null = fall back to the global MAX_POSITION_PER_SKU. */
  maxQty: number | null;
}

let cache = new Map<string, SkuOverride>();

/** Reload the override cache from WatchlistEntry. Never throws. */
export async function loadOverrides(): Promise<number> {
  try {
    const rows = await prisma.watchlistEntry.findMany({
      select: { skuKey: true, active: true, maxBuyRef: true, minSellRef: true, maxQty: true },
    });
    const next = new Map<string, SkuOverride>();
    for (const r of rows) {
      next.set(r.skuKey, {
        active: r.active,
        maxBuyRef: r.maxBuyRef,
        minSellRef: r.minSellRef ?? null,
        maxQty: r.maxQty ?? null,
      });
    }
    cache = next;
    return cache.size;
  } catch (e) {
    logger.warn({ err: errMessage(e) }, '[overrides] load failed; keeping previous overrides');
    return cache.size;
  }
}

export function getOverride(skuKey: string): SkuOverride | null {
  return cache.get(skuKey) ?? null;
}

/** Test seam: set the override cache directly. */
export function __setOverridesForTest(entries: Array<[string, SkuOverride]>): void {
  cache = new Map(entries);
}

// --- Pure application helpers (no I/O — unit-testable) ---

/** A SKU with no entry is active by default. */
export function isSkuActive(ovr: SkuOverride | null): boolean {
  return ovr ? ovr.active : true;
}

/** Effective position cap: per-SKU maxQty when set, else the global cap. */
export function effectiveCap(ovr: SkuOverride | null, globalCap: number): number {
  return ovr?.maxQty ?? globalCap;
}

/** Tighten the pricedb buy rail with the per-SKU ceiling (never loosen it). */
export function effectiveRefBuy(refBuyRef: number, ovr: SkuOverride | null): number {
  return ovr ? Math.min(refBuyRef, ovr.maxBuyRef) : refBuyRef;
}

/** Raise the pricedb sell rail with the per-SKU floor (never lower it). */
export function effectiveRefSell(refSellRef: number, ovr: SkuOverride | null): number {
  return ovr?.minSellRef != null ? Math.max(refSellRef, ovr.minSellRef) : refSellRef;
}
