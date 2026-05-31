// Convert a bp.tf item object (from the WS listings stream or REST) into a
// canonical tf2-sku string. This format matches what pricedb.io returns and what
// the watch-list / order book key on, so a listing's SKU and a watch-list SKU
// compare byte-for-byte.
//
// Format (tf2-sku order):
//   defindex;quality[;u<effect>][;australium][;kt-<tier>][;uncraftable][;td-<defindex>][;festive]
//
// Examples:
//   Mann Co. Key (5021, q6)                 -> "5021;6"
//   Australium Rocket Launcher (205, q11)   -> "205;11;australium"
//   Pro KS Rocket Launcher (205, q11, kt3)  -> "205;11;kt-3"
//   Burning Flames Team Captain (378, q5)   -> "378;5;u13"
//
// We don't depend on the `tf2-sku` npm package so the bot stays buildable
// offline; the output is tf2-sku compatible for the attributes we care about.

interface BptfItemLike {
  defindex?: number | string;
  // quality can be a number or { id, name }
  quality?: number | string | { id?: number | string };
  // unusual effect: several schemas in the wild
  particle?: number | { id?: number | string };
  effect?: number | { id?: number | string };
  priceindex?: number | string;
  australium?: boolean;
  // killstreak tier 1/2/3
  killstreakTier?: number | string;
  killstreak?: number | string;
  // craftability: prefer explicit `craftable`, fall back to the flag
  craftable?: boolean;
  flag_cannot_craft?: boolean;
  // kit / strangifier target
  target?: number | { defindex?: number | string };
  targetDefindex?: number | string;
  festivized?: boolean;
  festive?: boolean;
}

function asNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object') {
    const obj = v as { id?: unknown; defindex?: unknown };
    if ('id' in obj) return asNum(obj.id);
    if ('defindex' in obj) return asNum(obj.defindex);
  }
  return null;
}

/** Throws on a missing defindex/quality so callers can drop the event. */
export function itemToSku(itemInput: unknown): string {
  const item = (itemInput ?? {}) as BptfItemLike;
  const defindex = asNum(item.defindex);
  const quality = asNum(item.quality);
  if (defindex == null || quality == null) {
    throw new Error(`itemToSku: missing defindex/quality (defindex=${String(item.defindex)}, quality=${String(item.quality)})`);
  }

  const parts: string[] = [`${defindex}`, `${quality}`];

  // unusual effect
  const effect = asNum(item.particle) ?? asNum(item.effect) ?? (quality === 5 ? asNum(item.priceindex) : null);
  if (effect != null) parts.push(`u${effect}`);

  if (item.australium === true) parts.push('australium');

  const ksTier = asNum(item.killstreakTier) ?? asNum(item.killstreak);
  if (ksTier != null && ksTier > 0) parts.push(`kt-${ksTier}`);

  // craftable: explicit field wins; otherwise infer from the cannot-craft flag.
  const craftable = item.craftable != null ? item.craftable : !item.flag_cannot_craft;
  if (craftable === false) parts.push('uncraftable');

  const target = asNum(item.target) ?? asNum(item.targetDefindex);
  if (target != null) parts.push(`td-${target}`);

  if (item.festivized === true || item.festive === true) parts.push('festive');

  return parts.join(';');
}

/** Parse defindex + quality back out of a SKU, for SkuRef hydration. */
export function parseSku(sku: string): { defindex: number; quality: number; craftable: boolean } {
  const parts = sku.split(';');
  return {
    defindex: Number(parts[0]),
    quality: Number(parts[1] ?? 6),
    craftable: !parts.includes('uncraftable'),
  };
}
