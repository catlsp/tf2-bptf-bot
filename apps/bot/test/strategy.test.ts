import { describe, it, expect, vi } from 'vitest';

// strategy.ts reads `env` at import time (config validates process.env and would
// throw without real Steam creds), so we mock the config with just the knobs the
// pricing functions read.
const h = vi.hoisted(() => ({
  env: {
    BUY_DISCOUNT_PCT: 8,
    SELL_MARKUP_PCT: 12,
    MM_MAX_BUY_REF: undefined as number | undefined,
    MM_MIN_SPREAD_SCRAP: 1,
  } as Record<string, unknown>,
}));
vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));

import {
  evaluateListingBuyPrice,
  evaluateListingSellPrice,
  priceCompetitiveBuy,
  priceCompetitiveSell,
} from '../src/pricing/strategy.js';

describe('evaluateListingBuyPrice', () => {
  it('discount caps the price when it is below the sell-floor undercut', () => {
    // applyDiscount(3.0, 8) = 2.76; lowestSell - 0.11 = 2.89; min = 2.76
    const result = evaluateListingBuyPrice({
      skuKey: 'test',
      market: { fairValueRef: 3.0, lowestSellRef: 3.0, highestBuyRef: 2.0 },
    });
    expect(result).toBe(2.76);
  });

  it('undercuts the sell floor by one scrap when that is the tighter cap', () => {
    // discount 2.76, but a low sell floor 2.5 forces undercut 2.5 - 0.11 = 2.39
    const result = evaluateListingBuyPrice({
      skuKey: 'test',
      market: { fairValueRef: 3.0, lowestSellRef: 2.5, highestBuyRef: 2.0 },
    });
    expect(result).toBe(2.39);
  });

  it('returns null when not competitive vs the highest buy order', () => {
    // discounted 2.76 <= highestBuy 2.88 → not competitive → null
    const result = evaluateListingBuyPrice({
      skuKey: 'test',
      market: { fairValueRef: 3.0, lowestSellRef: 3.0, highestBuyRef: 2.88 },
    });
    expect(result).toBeNull();
  });

  it('returns null when no sell floor exists (dead one-sided market)', () => {
    const result = evaluateListingBuyPrice({
      skuKey: 'test',
      market: { fairValueRef: 3.0, lowestSellRef: null, highestBuyRef: 2.0 },
    });
    expect(result).toBeNull();
  });

  it('returns null below MIN_VIABLE_REF (dust)', () => {
    const result = evaluateListingBuyPrice({
      skuKey: 'test',
      market: { fairValueRef: 0.01, lowestSellRef: 0.05, highestBuyRef: null },
    });
    expect(result).toBeNull();
  });
});

describe('evaluateListingSellPrice', () => {
  it('markup floor wins when the sell floor is comfortably above it', () => {
    // markup = applyMarkup(3, 12) = 3.36; aboveBid = 2 + 0.11 = 2.11; undercut = 4 - 0.11 = 3.89
    // targetSell = min(max(3.36, 2.11), 3.89) = 3.36
    const result = evaluateListingSellPrice({
      skuKey: 'test',
      market: { fairValueRef: 3, lowestSellRef: 4, highestBuyRef: 2 },
    });
    expect(result).toBe(3.36);
  });

  it('first seller (no sell floor) → markup floor', () => {
    const result = evaluateListingSellPrice({
      skuKey: 'test',
      market: { fairValueRef: 3, lowestSellRef: null, highestBuyRef: 2 },
    });
    expect(result).toBe(3.36);
  });

  it('returns null when undercutting the floor would breach the markup', () => {
    // undercut = 3.1 - 0.11 = 2.99 < markup 3.36 → no margin → null
    const result = evaluateListingSellPrice({
      skuKey: 'test',
      market: { fairValueRef: 3, lowestSellRef: 3.1, highestBuyRef: 2 },
    });
    expect(result).toBeNull();
  });

  it('returns null on dust fair value', () => {
    // 0.04 < MIN_VIABLE_REF (0.05) → null (spec used 0.05, but that is the exact
    // boundary; the guard is a strict `<`, matching evaluateListingBuyPrice)
    const result = evaluateListingSellPrice({
      skuKey: 'test',
      market: { fairValueRef: 0.04, lowestSellRef: 1, highestBuyRef: null },
    });
    expect(result).toBeNull();
  });
});

describe('priceCompetitiveBuy', () => {
  const base = { maxBuyCapRef: 30, minSpreadScrap: 1 };

  it('bids at the pricedb buy level (the real market), not a stale book', () => {
    // ToD: market buys 26.11, sells 26.44 → bid 26.11 (competitive), spread 3 scrap
    const r = priceCompetitiveBuy({ refBuyRef: 26.11, refSellRef: 26.44, ...base });
    expect(r).toBe(26.11);
  });

  it('returns null above the price cap', () => {
    // 57 ref key > 30 cap → skip
    expect(priceCompetitiveBuy({ refBuyRef: 57, refSellRef: 58, ...base })).toBeNull();
  });

  it('returns null when the spread is below the minimum (no flip margin)', () => {
    // sell − buy = 0.05 < 1 scrap → skip
    expect(priceCompetitiveBuy({ refBuyRef: 5.0, refSellRef: 5.05, ...base })).toBeNull();
  });

  it('trades a razor-thin 1-scrap spread (ToD-style)', () => {
    // buy 26.11, sell 26.22 → exactly 1 scrap → allowed, bid 26.11
    expect(priceCompetitiveBuy({ refBuyRef: 26.11, refSellRef: 26.22, ...base })).toBe(26.11);
  });

  it('returns null on dust', () => {
    expect(priceCompetitiveBuy({ refBuyRef: 0.01, refSellRef: 0.5, ...base })).toBeNull();
  });
});

describe('priceCompetitiveSell', () => {
  it('lists at the pricedb sell level when it clears the cost floor', () => {
    // sell 26.44, cost 26.11 + 1 scrap floor 26.22 → 26.44
    expect(priceCompetitiveSell(26.44, 26.11, 1)).toBe(26.44);
  });

  it('floors at cost + min spread when pricedb sell is below it', () => {
    // sell 26.0 but cost 26.11 + 1 scrap = 26.22 → list at 26.22 (never at a loss)
    expect(priceCompetitiveSell(26.0, 26.11, 1)).toBe(26.22);
  });

  it('returns null on dust', () => {
    expect(priceCompetitiveSell(0.02, 0, 1)).toBeNull();
  });
});
