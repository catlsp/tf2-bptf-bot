import type { ItemSku } from '@bptf/types';

// --- TF2 currency constants (same defindexes as tf2vault bot.js) ---
export const DEFINDEX = {
  KEY: 5021,
  REFINED: 5002,
  RECLAIMED: 5001,
  SCRAP: 5000,
} as const;

/** Refined-metal value of raw metal counts. Mirrors bot.js: ref + rec/3 + scrap/9. */
export function metalToRef(refined: number, reclaimed: number, scrap: number): number {
  return round2(refined + reclaimed / 3 + scrap / 9);
}

/** Round to 2 decimals — ref is conventionally expressed to the scrap (0.11). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the canonical SKU key. Format: "defindex;quality[;uncraftable][;kt-N][;australium]".
 * Kept deterministic so it matches the DB unique key and bp.tf-derived keys.
 */
export function buildSkuKey(item: {
  defindex: number;
  quality: number;
  craftable: boolean;
  killstreak?: number;
  australium?: boolean;
  effect?: number | null;
}): string {
  const parts = [`${item.defindex}`, `${item.quality}`];
  if (!item.craftable) parts.push('uncraftable');
  if (item.killstreak && item.killstreak > 0) parts.push(`kt-${item.killstreak}`);
  if (item.australium) parts.push('australium');
  if (item.effect != null) parts.push(`u${item.effect}`);
  return parts.join(';');
}

/** Pull the leading defindex back out of a SKU key. */
export function defindexFromSkuKey(skuKey: string): number {
  return Number(skuKey.split(';')[0]);
}

export function toItemSku(input: Omit<ItemSku, 'skuKey'>): ItemSku {
  return { ...input, skuKey: buildSkuKey(input) };
}

/** Percentage helpers used by the strategy. */
export function applyDiscount(value: number, pct: number): number {
  return round2(value * (1 - pct / 100));
}

export function applyMarkup(value: number, pct: number): number {
  return round2(value * (1 + pct / 100));
}
