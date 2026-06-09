import { describe, it, expect, vi, beforeEach } from 'vitest';

// The pure override helpers decide how a WatchlistEntry steers the bot. The
// loader hydrates the cache from the DB; we mock prisma so no real DB is hit.
const h = vi.hoisted(() => ({
  findMany: vi.fn(),
}));
vi.mock('../src/integrations/db.js', () => ({ prisma: { watchlistEntry: { findMany: h.findMany } } }));
vi.mock('../src/lib/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import {
  loadOverrides,
  getOverride,
  __setOverridesForTest,
  isSkuActive,
  effectiveCap,
  effectiveRefBuy,
  effectiveRefSell,
  type SkuOverride,
} from '../src/watchlist/overrides.js';

const ovr = (o: Partial<SkuOverride> = {}): SkuOverride => ({
  active: true,
  maxBuyRef: 9999,
  minSellRef: null,
  maxQty: null,
  ...o,
});

beforeEach(() => vi.clearAllMocks());

describe('override pure helpers', () => {
  it('a SKU with no entry is active and uses the global cap / rails', () => {
    expect(isSkuActive(null)).toBe(true);
    expect(effectiveCap(null, 3)).toBe(3);
    expect(effectiveRefBuy(26, null)).toBe(26);
    expect(effectiveRefSell(27, null)).toBe(27);
  });

  it('inactive entry pauses the SKU', () => {
    expect(isSkuActive(ovr({ active: false }))).toBe(false);
  });

  it('maxQty overrides the global cap; null falls back', () => {
    expect(effectiveCap(ovr({ maxQty: 1 }), 3)).toBe(1);
    expect(effectiveCap(ovr({ maxQty: null }), 3)).toBe(3);
  });

  it('maxBuyRef only tightens the buy rail, never loosens it', () => {
    expect(effectiveRefBuy(26, ovr({ maxBuyRef: 5 }))).toBe(5); // tighter wins
    expect(effectiveRefBuy(4, ovr({ maxBuyRef: 5 }))).toBe(4); // rail already tighter
  });

  it('minSellRef only raises the sell rail, never lowers it', () => {
    expect(effectiveRefSell(27, ovr({ minSellRef: 30 }))).toBe(30); // higher floor wins
    expect(effectiveRefSell(27, ovr({ minSellRef: 20 }))).toBe(27); // rail already higher
    expect(effectiveRefSell(27, ovr({ minSellRef: null }))).toBe(27);
  });
});

describe('loadOverrides', () => {
  it('hydrates the cache from WatchlistEntry rows', async () => {
    h.findMany.mockResolvedValue([
      { skuKey: '725;6', active: true, maxBuyRef: 25, minSellRef: 28, maxQty: 2 },
      { skuKey: 'x;6', active: false, maxBuyRef: 9999, minSellRef: null, maxQty: null },
    ]);
    const n = await loadOverrides();
    expect(n).toBe(2);
    expect(getOverride('725;6')).toEqual({ active: true, maxBuyRef: 25, minSellRef: 28, maxQty: 2 });
    expect(getOverride('x;6')).toEqual({ active: false, maxBuyRef: 9999, minSellRef: null, maxQty: null });
    expect(getOverride('missing;6')).toBeNull();
  });

  it('keeps the previous cache when the DB read fails', async () => {
    __setOverridesForTest([['a;6', ovr({ maxQty: 1 })]]);
    h.findMany.mockRejectedValue(new Error('db down'));
    const n = await loadOverrides();
    expect(n).toBe(1);
    expect(getOverride('a;6')).toMatchObject({ maxQty: 1 });
  });
});
