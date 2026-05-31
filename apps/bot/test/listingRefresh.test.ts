import { describe, it, expect, vi, beforeEach } from 'vitest';

// All bp.tf / DB / Redis I/O is mocked. No real network or DB calls happen here.
// We exercise the real listingRefresh.runOnce() and the real listingPricer.

const h = vi.hoisted(() => ({
  env: {
    PAPER_LISTINGS: false,
    BUY_DISCOUNT_PCT: 20,
    LISTING_PRICE_DRIFT_PCT: 2,
    MAX_LISTINGS: 30,
    LISTING_DETAILS_TEMPLATE: 'Bot offering {priceRef} ref',
    BPTF_LISTING_DELAY_MS: 0,
    LISTING_REFRESH_INTERVAL_SEC: 1800,
  } as Record<string, unknown>,
  prisma: { ourListing: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() } },
  logEvent: vi.fn(),
  redis: { smembers: vi.fn() },
  createListing: vi.fn(),
  deleteListing: vi.fn(),
  listMyListings: vi.fn(),
  fetchAutoprice: vi.fn(),
  refreshKeyPrice: vi.fn(),
  currentKeyRef: vi.fn(() => 63),
  isStopped: vi.fn(),
  publish: vi.fn(),
  getSkuName: vi.fn(),
  getOrderBook: vi.fn(),
}));

vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));
vi.mock('../src/integrations/db.js', () => ({ prisma: h.prisma, logEvent: h.logEvent }));
vi.mock('../src/integrations/redis.js', () => ({ redis: h.redis }));
vi.mock('../src/integrations/bptf.js', () => ({
  createListing: h.createListing,
  deleteListing: h.deleteListing,
  listMyListings: h.listMyListings,
  fetchAutoprice: h.fetchAutoprice,
  refreshKeyPrice: h.refreshKeyPrice,
  currentKeyRef: h.currentKeyRef,
}));
vi.mock('../src/risk/emergencyStop.js', () => ({ isStopped: h.isStopped }));
vi.mock('../src/events/publisher.js', () => ({ publish: h.publish, nowIso: () => 'now' }));
vi.mock('../src/watchlist/refreshWatchList.js', () => ({ getSkuName: h.getSkuName }));
vi.mock('../src/orderbook/orderBook.js', () => ({ getOrderBook: h.getOrderBook }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runOnce, startListingRefresh, deleteAllOurListings } from '../src/jobs/listingRefresh.js';
import { refToKeysAndMetal } from '../src/pricing/listingPricer.js';

function activeRow(over: Partial<Record<string, unknown>> = {}) {
  return { id: 'a1', skuKey: '30;6', intent: 'buy', priceRef: 8, bptfListingId: '111', status: 'active', ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  // defaults — a clean run with no existing listings and a priced item
  h.env.PAPER_LISTINGS = false;
  h.env.MAX_LISTINGS = 30;
  h.env.LISTING_PRICE_DRIFT_PCT = 2;
  h.env.BUY_DISCOUNT_PCT = 20;
  h.isStopped.mockResolvedValue(false);
  h.refreshKeyPrice.mockResolvedValue(63);
  h.currentKeyRef.mockReturnValue(63);
  h.listMyListings.mockResolvedValue([]);
  h.prisma.ourListing.findMany.mockResolvedValue([]);
  h.prisma.ourListing.create.mockResolvedValue({ id: 'row1' });
  h.prisma.ourListing.update.mockResolvedValue({});
  h.redis.smembers.mockResolvedValue([]);
  h.getSkuName.mockResolvedValue('Some Item');
  h.fetchAutoprice.mockResolvedValue({ skuKey: 'x', buyRef: 10, sellRef: 12 });
  h.createListing.mockResolvedValue({ bptfListingId: '111' });
  h.deleteListing.mockResolvedValue(undefined);
  h.getOrderBook.mockResolvedValue({ buys: [], sells: [] });
});

describe('listingRefresh — Phase 2 BUY maker', () => {
  it('1. PAPER_LISTINGS=true → startListingRefresh does nothing', () => {
    h.env.PAPER_LISTINGS = true;
    startListingRefresh();
    expect(h.listMyListings).not.toHaveBeenCalled();
    expect(h.createListing).not.toHaveBeenCalled();
  });

  it('2. empty watch-list → no create calls', async () => {
    h.redis.smembers.mockResolvedValue([]);
    await runOnce();
    expect(h.createListing).not.toHaveBeenCalled();
  });

  it('3. three SKUs, none existing → 3 createListing + 3 active updates', async () => {
    h.redis.smembers.mockResolvedValue(['30;6', '35;6', '40;6']);
    await runOnce();
    expect(h.createListing).toHaveBeenCalledTimes(3);
    expect(h.prisma.ourListing.create).toHaveBeenCalledTimes(3);
    const activeUpdates = h.prisma.ourListing.update.mock.calls.filter(
      (c) => (c[0] as { data?: { status?: string } }).data?.status === 'active',
    );
    expect(activeUpdates).toHaveLength(3);
  });

  it('4. existing at same price → skipped, no API calls', async () => {
    h.redis.smembers.mockResolvedValue(['30;6']);
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow({ priceRef: 8 })]);
    h.listMyListings.mockResolvedValue([{ bptfListingId: '111', intent: 'buy' }]);
    h.fetchAutoprice.mockResolvedValue({ buyRef: 10 }); // computeBuyPrice → 8 == existing
    await runOnce();
    expect(h.createListing).not.toHaveBeenCalled();
    expect(h.deleteListing).not.toHaveBeenCalled();
  });

  it('5. price drift > threshold → delete + recreate', async () => {
    h.redis.smembers.mockResolvedValue(['30;6']);
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow({ priceRef: 8 })]);
    h.listMyListings.mockResolvedValue([{ bptfListingId: '111', intent: 'buy' }]);
    h.fetchAutoprice.mockResolvedValue({ buyRef: 12 }); // → 9.6, 20% drift
    await runOnce();
    expect(h.deleteListing).toHaveBeenCalledWith('111');
    expect(h.createListing).toHaveBeenCalledTimes(1);
  });

  it('6. MAX_LISTINGS reached → stops creating, no error', async () => {
    h.env.MAX_LISTINGS = 1;
    h.redis.smembers.mockResolvedValue(['99;6']);
    // one unrelated active listing already counts toward the cap
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow({ skuKey: '30;6' })]);
    h.listMyListings.mockResolvedValue([{ bptfListingId: '111', intent: 'buy' }]);
    await runOnce();
    expect(h.createListing).not.toHaveBeenCalled();
  });

  it('7. createListing throws → DB row marked failed', async () => {
    h.redis.smembers.mockResolvedValue(['30;6']);
    h.createListing.mockRejectedValue(new Error('bp.tf 429'));
    await runOnce();
    const failed = h.prisma.ourListing.update.mock.calls.find(
      (c) => (c[0] as { data?: { status?: string } }).data?.status === 'failed',
    );
    expect(failed).toBeDefined();
    expect((failed![0] as { data: { errorMessage: string } }).data.errorMessage).toContain('429');
  });

  it('8. emergency stop → deletes all, no creates', async () => {
    h.isStopped.mockResolvedValue(true);
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow()]);
    await runOnce();
    expect(h.deleteListing).toHaveBeenCalledWith('111');
    expect(h.createListing).not.toHaveBeenCalled();
  });

  it('9. currency SKU (5021;6) is skipped', async () => {
    h.redis.smembers.mockResolvedValue(['5021;6']);
    await runOnce();
    expect(h.createListing).not.toHaveBeenCalled();
    expect(h.fetchAutoprice).not.toHaveBeenCalled();
  });

  it('10. reconcile: DB active but missing on remote → marked deleted', async () => {
    h.redis.smembers.mockResolvedValue([]); // isolate reconcile
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow()]);
    h.listMyListings.mockResolvedValue([]); // remote empty
    await runOnce();
    const del = h.prisma.ourListing.update.mock.calls.find(
      (c) => (c[0] as { data?: { errorMessage?: string } }).data?.errorMessage === 'missing on remote',
    );
    expect(del).toBeDefined();
  });

  it('11. fair value null (no name, empty book) → SKU skipped', async () => {
    h.redis.smembers.mockResolvedValue(['30;6']);
    h.getSkuName.mockResolvedValue(null);
    h.getOrderBook.mockResolvedValue({ buys: [], sells: [] });
    await runOnce();
    expect(h.createListing).not.toHaveBeenCalled();
  });

  it('12. refToKeysAndMetal(70) with key=63 → keys 1, metal floored to scrap (6.93)', () => {
    h.currentKeyRef.mockReturnValue(63);
    const r = refToKeysAndMetal(70);
    expect(r.keys).toBe(1);
    // spec example said 7.04, but roundToScrap floors ("never overpay"): 7/0.11 -> 63 scrap -> 6.93
    expect(r.metal).toBe(6.93);
  });

  it('bonus: deleteAllOurListings deletes every active listing', async () => {
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow({ bptfListingId: '111' }), activeRow({ id: 'a2', bptfListingId: '222' })]);
    await deleteAllOurListings('manual');
    expect(h.deleteListing).toHaveBeenCalledWith('111');
    expect(h.deleteListing).toHaveBeenCalledWith('222');
  });
});
