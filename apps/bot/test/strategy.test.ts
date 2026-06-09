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
  evaluateMarketMakingBuy,
  evaluateMarketMakingSell,
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

describe('evaluateMarketMakingBuy', () => {
  it('bids one scrap above the highest existing buy order', () => {
    const r = evaluateMarketMakingBuy({ buys: [{ priceRef: 70.55 }, { priceRef: 70.44 }], sells: [] });
    expect(r).toBe(70.66);
  });

  it('returns null when there are no buy orders to beat', () => {
    expect(evaluateMarketMakingBuy({ buys: [], sells: [{ priceRef: 72.11 }] })).toBeNull();
  });

  it('caps the bid at MM_MAX_BUY_REF when set', () => {
    h.env.MM_MAX_BUY_REF = 70.0;
    const r = evaluateMarketMakingBuy({ buys: [{ priceRef: 70.55 }], sells: [] });
    expect(r).toBe(70.0);
    h.env.MM_MAX_BUY_REF = undefined;
  });

  it('hard rail: never bids above the pricedb reference buy', () => {
    // book wants 70.66, but pricedb says the item is only worth 5 to buy → clamp to 5
    const r = evaluateMarketMakingBuy({ buys: [{ priceRef: 70.55 }], sells: [] }, { refBuyRef: 5 });
    expect(r).toBe(5);
  });

  it('leaves the bid untouched when it is already within the pricedb rail', () => {
    const r = evaluateMarketMakingBuy({ buys: [{ priceRef: 4 }], sells: [] }, { refBuyRef: 5 });
    expect(r).toBe(4.11);
  });
});

describe('evaluateMarketMakingSell', () => {
  it('undercuts the lowest ask by one scrap when above the cost floor', () => {
    const r = evaluateMarketMakingSell({ buys: [], sells: [{ priceRef: 72.11 }, { priceRef: 72.22 }] }, 70.66);
    expect(r).toBe(72.0);
  });

  it('returns null when there are no asks to undercut', () => {
    expect(evaluateMarketMakingSell({ buys: [{ priceRef: 70.0 }], sells: [] }, 50)).toBeNull();
  });

  it('returns null when undercutting would dip below cost + min spread', () => {
    // lowest 71.00 → undercut 70.89; cost 71.00 + 1 scrap = 71.11 > 70.89 → null
    expect(evaluateMarketMakingSell({ buys: [], sells: [{ priceRef: 71.0 }] }, 71.0)).toBeNull();
  });

  it('hard rail: refuses to sell below the pricedb reference sell', () => {
    // book undercut 72.00 is fine vs cost, but pricedb floor 73 forbids it → null
    expect(
      evaluateMarketMakingSell({ buys: [], sells: [{ priceRef: 72.11 }] }, 50, { refSellRef: 73 }),
    ).toBeNull();
  });

  it('allows the undercut when it clears the pricedb reference sell', () => {
    // undercut 72.00 >= floor max(cost+spread, refSell 70) → 72.00
    expect(
      evaluateMarketMakingSell({ buys: [], sells: [{ priceRef: 72.11 }] }, 50, { refSellRef: 70 }),
    ).toBe(72.0);
  });
});
