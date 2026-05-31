import type { SkuRef } from '../pricing/fairValue.js';
import { buildSkuKey } from '../lib/utils.js';

// Initial 20-SKU watchlist of cheap, liquid junk that fits 1 key + 90 ref.
// Quality 6 = Unique, 11 = Strange. craftable: true. These are starter targets
// in the 0.05–5 ref band; the runtime manager can add/remove later (Phase 7).

interface Seed {
  defindex: number;
  quality: number;
  craftable: boolean;
  killstreak?: number;
  name: string;
}

const SEEDS: Seed[] = [
  // --- cheap Unique hats (0.05–2 ref band) ---
  { defindex: 448, quality: 6, craftable: true, name: 'Modest Pile of Hat' },
  { defindex: 30062, quality: 6, craftable: true, name: 'Frenchman’s Beret' },
  { defindex: 377, quality: 6, craftable: true, name: 'Cheaters Lament' },
  { defindex: 53, quality: 6, craftable: true, name: 'Ye Olde Baker Boy' },
  { defindex: 81, quality: 6, craftable: true, name: 'Bonk Helm' },
  { defindex: 71, quality: 6, craftable: true, name: 'Ten Gallon Hat' },
  { defindex: 94, quality: 6, craftable: true, name: 'Engineer’s Cap' },
  { defindex: 99, quality: 6, craftable: true, name: 'Camera Beard' },
  // --- Strange weapons (0.5–5 ref band) ---
  { defindex: 200, quality: 11, craftable: true, name: 'Strange Lugermorph' },
  { defindex: 13, quality: 11, craftable: true, name: 'Strange Scattergun' },
  { defindex: 18, quality: 11, craftable: true, name: 'Strange Rocket Launcher' },
  { defindex: 24, quality: 11, craftable: true, name: 'Strange Revolver' },
  { defindex: 9, quality: 11, craftable: true, name: 'Strange Shotgun' },
  { defindex: 15, quality: 11, craftable: true, name: 'Strange Minigun' },
  { defindex: 21, quality: 11, craftable: true, name: 'Strange Flame Thrower' },
  { defindex: 42, quality: 6, craftable: true, name: 'Strange Sandvich' },
  // --- crates / commons that move volume ---
  { defindex: 5022, quality: 6, craftable: true, name: 'Mann Co. Supply Munition' },
  { defindex: 725, quality: 6, craftable: true, name: 'Tour of Duty Ticket' },
  { defindex: 5045, quality: 6, craftable: true, name: 'Sticky Jumper' },
  { defindex: 405, quality: 6, craftable: true, name: 'Ali Baba’s Wee Booties' },
];

export function getSeedWatchlist(limit: number): SkuRef[] {
  return SEEDS.slice(0, limit).map((s) => ({
    skuKey: buildSkuKey(s),
    name: s.name,
    quality: s.quality,
    craftable: s.craftable,
  }));
}
