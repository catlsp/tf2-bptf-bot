import { describe, it, expect, vi, beforeEach } from 'vitest';

// The oracle folds pricedb's keys+metal into refined at the live key rate and
// never clobbers a good cache when the feed comes back empty. We mock the feed
// and the key rate so the conversion + fallback logic is the only thing tested.
const h = vi.hoisted(() => ({
  env: { PRICEDB_REFRESH_SEC: 1800 } as Record<string, unknown>,
  fetchPricedbRows: vi.fn(),
  currentKeyRef: vi.fn(() => 63),
}));

vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));
vi.mock('../src/pricing/pricedbFeed.js', () => ({ fetchPricedbRows: h.fetchPricedbRows }));
vi.mock('../src/integrations/bptf.js', () => ({ currentKeyRef: h.currentKeyRef }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { refreshPriceOracle, getRefPrice, oracleSize } from '../src/pricing/priceOracle.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.currentKeyRef.mockReturnValue(63);
});

describe('priceOracle', () => {
  it('folds keys + metal into refined at the current key rate', async () => {
    h.fetchPricedbRows.mockResolvedValue([
      { sku: '725;6', buy: { keys: 0, metal: 26 }, sell: { keys: 0, metal: 27 }, time: 100 },
      { sku: 'hat;6', buy: { keys: 1, metal: 5 }, sell: { keys: 1, metal: 10 }, time: 200 },
    ]);
    await refreshPriceOracle();

    expect(getRefPrice('725;6')).toMatchObject({ buyRef: 26, sellRef: 27 });
    // 1 key folds in at 63 ref: buy 1*63+5 = 68, sell 1*63+10 = 73
    expect(getRefPrice('hat;6')).toMatchObject({ buyRef: 68, sellRef: 73 });
  });

  it('re-folds keys at the updated key rate on read', async () => {
    h.fetchPricedbRows.mockResolvedValue([
      { sku: 'hat;6', buy: { keys: 1, metal: 0 }, sell: { keys: 1, metal: 0 }, time: 1 },
    ]);
    await refreshPriceOracle();
    h.currentKeyRef.mockReturnValue(70); // key rate moved after the refresh
    expect(getRefPrice('hat;6')).toMatchObject({ buyRef: 70, sellRef: 70 });
  });

  it('returns null for an unknown SKU (hard-rails: do not trade it)', async () => {
    h.fetchPricedbRows.mockResolvedValue([{ sku: 'a;6', buy: { metal: 1 }, sell: { metal: 2 } }]);
    await refreshPriceOracle();
    expect(getRefPrice('missing;6')).toBeNull();
  });

  it('keeps the previous cache when the feed comes back empty', async () => {
    h.fetchPricedbRows.mockResolvedValue([{ sku: 'a;6', buy: { metal: 1 }, sell: { metal: 2 } }]);
    await refreshPriceOracle();
    const before = oracleSize();

    h.fetchPricedbRows.mockResolvedValue([]); // outage
    await refreshPriceOracle();

    expect(oracleSize()).toBe(before);
    expect(getRefPrice('a;6')).toMatchObject({ buyRef: 1, sellRef: 2 });
  });

  it('drops rows with no price on either side', async () => {
    h.fetchPricedbRows.mockResolvedValue([
      { sku: 'dead;6', buy: { keys: 0, metal: 0 }, sell: { keys: 0, metal: 0 } },
    ]);
    await refreshPriceOracle();
    expect(getRefPrice('dead;6')).toBeNull();
  });
});
