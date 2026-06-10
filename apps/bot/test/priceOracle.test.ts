import { describe, it, expect, vi, beforeEach } from 'vitest';

// The oracle prices the Redis watch set per-SKU (/api/item), folds keys+metal
// into refined at the live key rate, accumulates across refreshes, and never
// clobbers a good cache on a full outage. We mock the feed, the watch set, the
// key rate, and sleep so only that logic is under test.
const h = vi.hoisted(() => ({
  env: { PRICEDB_REFRESH_SEC: 1800 } as Record<string, unknown>,
  fetchPricedbItem: vi.fn(),
  smembers: vi.fn(),
  ownedFindMany: vi.fn(),
  currentKeyRef: vi.fn(() => 63),
}));

vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));
vi.mock('../src/pricing/pricedbFeed.js', () => ({ fetchPricedbItem: h.fetchPricedbItem }));
vi.mock('../src/integrations/redis.js', () => ({ redis: { smembers: h.smembers } }));
vi.mock('../src/integrations/db.js', () => ({ prisma: { inventoryItem: { findMany: h.ownedFindMany } } }));
vi.mock('../src/integrations/bptf.js', () => ({ currentKeyRef: h.currentKeyRef }));
vi.mock('../src/lib/utils.js', async (orig) => {
  const actual = await orig<typeof import('../src/lib/utils.js')>();
  return { ...actual, sleep: vi.fn(() => Promise.resolve()) };
});
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { refreshPriceOracle, getRefPrice, oracleSize } from '../src/pricing/priceOracle.js';

const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.clearAllMocks();
  h.currentKeyRef.mockReturnValue(63);
  h.ownedFindMany.mockResolvedValue([]);
});

describe('priceOracle', () => {
  it('prices each watched SKU and folds keys at the current key rate', async () => {
    h.smembers.mockResolvedValue(['725;6', 'hat;6']);
    h.fetchPricedbItem.mockImplementation((sku: string) =>
      Promise.resolve(
        sku === '725;6'
          ? { sku, buy: { keys: 0, metal: 26 }, sell: { keys: 0, metal: 27 }, time: now() }
          : { sku, buy: { keys: 1, metal: 5 }, sell: { keys: 1, metal: 10 }, time: now() },
      ),
    );
    await refreshPriceOracle();

    expect(getRefPrice('725;6')).toMatchObject({ buyRef: 26, sellRef: 27 });
    // 1 key folds in at 63 ref: buy 1*63+5 = 68, sell 1*63+10 = 73
    expect(getRefPrice('hat;6')).toMatchObject({ buyRef: 68, sellRef: 73 });
  });

  it('re-folds keys at the updated key rate on read', async () => {
    h.smembers.mockResolvedValue(['hat;6']);
    h.fetchPricedbItem.mockResolvedValue({ sku: 'hat;6', buy: { keys: 1, metal: 0 }, sell: { keys: 1, metal: 0 }, time: now() });
    await refreshPriceOracle();
    h.currentKeyRef.mockReturnValue(70); // key rate moved after the refresh
    expect(getRefPrice('hat;6')).toMatchObject({ buyRef: 70, sellRef: 70 });
  });

  it('returns null for an unknown SKU (hard-rails: do not trade it)', async () => {
    h.smembers.mockResolvedValue(['a;6']);
    h.fetchPricedbItem.mockResolvedValue({ sku: 'a;6', buy: { metal: 1 }, sell: { metal: 2 }, time: now() });
    await refreshPriceOracle();
    expect(getRefPrice('missing;6')).toBeNull();
  });

  it('expires a price older than the max age', async () => {
    h.smembers.mockResolvedValue(['old;6']);
    h.fetchPricedbItem.mockResolvedValue({
      sku: 'old;6',
      buy: { metal: 1 },
      sell: { metal: 2 },
      time: now() - 30 * 24 * 60 * 60, // 30 days old
    });
    await refreshPriceOracle();
    expect(getRefPrice('old;6')).toBeNull();
  });

  it('keeps last-good prices when every fetch fails (outage)', async () => {
    h.smembers.mockResolvedValue(['a;6']);
    h.fetchPricedbItem.mockResolvedValue({ sku: 'a;6', buy: { metal: 1 }, sell: { metal: 2 }, time: now() });
    await refreshPriceOracle();
    const before = oracleSize();

    h.fetchPricedbItem.mockResolvedValue(null); // total outage
    await refreshPriceOracle();

    expect(oracleSize()).toBe(before);
    expect(getRefPrice('a;6')).toMatchObject({ buyRef: 1, sellRef: 2 });
  });

  it('keeps a SKUs last-good price through a transient single-fetch failure', async () => {
    h.smembers.mockResolvedValue(['a;6', 'b;6']);
    h.fetchPricedbItem.mockImplementation((sku: string) =>
      Promise.resolve({ sku, buy: { metal: 1 }, sell: { metal: 2 }, time: now() }),
    );
    await refreshPriceOracle();

    // next refresh: a;6 still prices, b;6 blips out — a stays, b retains last-good
    h.fetchPricedbItem.mockImplementation((sku: string) =>
      Promise.resolve(sku === 'a;6' ? { sku, buy: { metal: 3 }, sell: { metal: 4 }, time: now() } : null),
    );
    await refreshPriceOracle();

    expect(getRefPrice('a;6')).toMatchObject({ buyRef: 3, sellRef: 4 });
    expect(getRefPrice('b;6')).toMatchObject({ buyRef: 1, sellRef: 2 });
  });

  it('prices owned (HELD/LISTED) SKUs even when absent from the watch set', async () => {
    h.smembers.mockResolvedValue(['watched;6']);
    h.ownedFindMany.mockResolvedValue([{ item: { skuKey: 'owned;6' } }]);
    h.fetchPricedbItem.mockImplementation((sku: string) =>
      Promise.resolve({ sku, buy: { metal: 1 }, sell: { metal: 2 }, time: now() }),
    );
    await refreshPriceOracle();
    expect(getRefPrice('owned;6')).toMatchObject({ buyRef: 1, sellRef: 2 });
  });

  it('drops rows with no price on either side', async () => {
    h.smembers.mockResolvedValue(['dead;6']);
    h.fetchPricedbItem.mockResolvedValue({ sku: 'dead;6', buy: { keys: 0, metal: 0 }, sell: { keys: 0, metal: 0 }, time: now() });
    await refreshPriceOracle();
    expect(getRefPrice('dead;6')).toBeNull();
  });
});
