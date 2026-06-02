import type { Prisma } from '@bptf/db';
import { prisma } from '../integrations/db.js';
import { parseSku } from '../util/itemToSku.js';

// Shared Item persistence. Centralises the SKU → Item field mapping so the
// scanner, trade executor and trade-settlement paths all build Item rows the
// same way (previously the trade path inlined a partial version that dropped
// killstreak/effect).

/** Build Item create data from a tf2-sku key + display name. */
export function skuToItemCreate(skuKey: string, name: string): Prisma.ItemCreateInput {
  const parts = skuKey.split(';');
  const { defindex, quality, craftable } = parseSku(skuKey);
  const killstreakPart = parts.find((part) => /^kt-\d+$/.test(part));
  const effectPart = parts.find((part) => /^u\d+$/.test(part));
  return {
    skuKey,
    name,
    defindex,
    quality,
    craftable,
    australium: parts.includes('australium'),
    killstreak: killstreakPart ? Number(killstreakPart.slice(3)) : 0,
    effect: effectPart ? Number(effectPart.slice(1)) : null,
  };
}

// Item.id is immutable for a given skuKey, so cache it process-wide. This avoids
// an upsert on every scan of every watched SKU (the scanner touches ~20+ SKUs
// per tick) while still creating the row the first time we see a SKU.
const itemIdCache = new Map<string, string>();

/**
 * Get the Item id for a SKU, creating the row the first time it's seen. The name
 * is only used on create — an empty `update` means a later caller with a weaker
 * name (e.g. a settlement falling back to the raw SKU) can't clobber the good
 * name the scanner first wrote. Memoised for the process.
 */
export async function getOrCreateItemId(skuKey: string, name: string): Promise<string> {
  const cached = itemIdCache.get(skuKey);
  if (cached) return cached;
  const item = await prisma.item.upsert({
    where: { skuKey },
    create: skuToItemCreate(skuKey, name),
    update: {},
    select: { id: true },
  });
  itemIdCache.set(skuKey, item.id);
  return item.id;
}
