import { describe, it, expect, vi } from 'vitest';

// strategy.ts reads `env` at import time (config validates process.env and would
// throw without real Steam creds), so we mock the config with just the knobs the
// pricing functions read.
const h = vi.hoisted(() => ({
  env: { BUY_DISCOUNT_PCT: 8, SELL_MARKUP_PCT: 12 } as Record<string, unknown>,
}));
vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));

import { evaluateListingBuyPrice, evaluateListingSellPrice } from '../src/pricing/strategy.js';

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
