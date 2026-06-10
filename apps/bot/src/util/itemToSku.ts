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

/**
 * SKUs our by-name createListing can NOT express: killstreak kits/fabricators
 * (td-/od-/oq-), decorated war-paint items (w<wear>/pk<paintkit>), unusual
 * effects (u<id>), killstreak weapons (kt-), australium, festivized. bp.tf
 * rejects these with 500 "Item is invalid" when created by item name + quality —
 * they need structured attributes we don't send. Only plain
 * `defindex;quality[;uncraftable]` items are listable.
 */
export function isUnsupportedSku(sku: string): boolean {
  return /;(td|od|oq|kt)-|;(w|pk|u)\d|;australium|;festive/.test(sku);
}

// Quality-id → the display-name prefix pricedb/bp.tf put in item names. Stripped
// quality-aware (only the prefix matching the SKU's quality), so legitimate item
// names like "Vintage Tyrolean" (a q6 item literally named Vintage…) survive.
const QUALITY_NAME_PREFIX: Record<number, string> = {
  1: 'Genuine ',
  3: 'Vintage ',
  5: 'Unusual ',
  11: 'Strange ',
  13: 'Haunted ',
  14: "Collector's ",
};

/**
 * Reduce a pricedb display name to the base schema name bp.tf item resolution
 * expects: quality and craftability travel as separate fields, so "Strange X" /
 * "Non-Craftable X" prefixes must come OFF the name (else bp.tf can't find the
 * item and the listing 500s).
 */
export function baseItemName(name: string, quality: number, craftable: boolean): string {
  let out = name;
  if (!craftable && out.startsWith('Non-Craftable ')) out = out.slice('Non-Craftable '.length);
  const prefix = QUALITY_NAME_PREFIX[quality];
  if (prefix && out.startsWith(prefix)) out = out.slice(prefix.length);
  return out;
}

/**
 * Map a Steam econ item (from a trade offer) to the exact SKU it represents, for
 * matching against our listings. Quality comes from app_data, craftability from
 * the "Not Usable in Crafting" description. Returns null when the item carries
 * attributes a plain SKU can't express (killstreak/australium/festivized) — the
 * caller must treat that as NON-matching, so e.g. a Killstreak or Non-Craftable
 * variant can never fill a listing priced for the plain craftable item.
 */
export function econItemToSku(item: {
  market_hash_name?: string;
  name?: string;
  app_data?: { def_index?: string | number; quality?: string | number };
  descriptions?: Array<{ value?: string }>;
}): string | null {
  const defindex = asNum(item.app_data?.def_index);
  if (defindex == null) return null;
  const name = item.market_hash_name || item.name || '';
  if (/Killstreak|Australium|Festivized/i.test(name)) return null; // unexpressible → never match
  const quality = asNum(item.app_data?.quality) ?? 6;
  const uncraftable = (item.descriptions ?? []).some((d) => (d.value ?? '').includes('Usable in Crafting'));
  return `${defindex};${quality}${uncraftable ? ';uncraftable' : ''}`;
}
