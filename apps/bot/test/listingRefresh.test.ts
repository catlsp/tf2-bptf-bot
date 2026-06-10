import { describe, it, expect, vi, beforeEach } from 'vitest';

// All bp.tf / DB / Redis I/O is mocked. No real network or DB calls happen here.
// We exercise the real listingRefresh.runOnce() and the real listingPricer.

const h = vi.hoisted(() => ({
  env: {
    PAPER_LISTINGS: false,
    BUY_DISCOUNT_PCT: 20,
    SELL_MARKUP_PCT: 12,
    LISTING_PRICE_DRIFT_PCT: 2,
    MAX_LISTINGS: 30,
    LISTING_DETAILS_TEMPLATE: 'Bot offering {priceRef} ref',
    BPTF_LISTING_DELAY_MS: 0,
    LISTING_REFRESH_INTERVAL_SEC: 1800,
    STALE_AUTOPRICE_PCT: 10,
    LIVE_MARKET_WEIGHT: 0.7,
    // Existing suite exercises the arbitrage path; MM mode is covered separately.
    STRATEGY_MODE: 'arbitrage',
    MM_MAX_BUY_REF: undefined,
    MM_MIN_SPREAD_SCRAP: 1,
    WATCHLIST_MODE: 'manual',
    TF2VAULT_RESERVE_REFINED: 0,
    MAX_POSITION_PER_SKU: 3,
  } as Record<string, unknown>,
  prisma: {
    ourListing: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    inventoryItem: { findMany: vi.fn(), update: vi.fn() },
    listing: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
  logEvent: vi.fn(),
  redis: { smembers: vi.fn() },
  createListing: vi.fn(),
  deleteListing: vi.fn(),
  updateListingPrice: vi.fn(),
  listMyListings: vi.fn(),
  fetchAutoprice: vi.fn(),
  refreshKeyPrice: vi.fn(),
  currentKeyRef: vi.fn(() => 63),
  isStopped: vi.fn(),
  publish: vi.fn(),
  getSkuName: vi.fn(),
  getOrderBook: vi.fn(),
  safeLoadMetal: vi.fn(),
  openPositionForSku: vi.fn(),
}));

vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));
vi.mock('../src/integrations/db.js', () => ({ prisma: h.prisma, logEvent: h.logEvent }));
vi.mock('../src/integrations/redis.js', () => ({ redis: h.redis }));
vi.mock('../src/integrations/bptf.js', () => ({
  createListing: h.createListing,
  deleteListing: h.deleteListing,
  updateListingPrice: h.updateListingPrice,
  listMyListings: h.listMyListings,
  fetchAutoprice: h.fetchAutoprice,
  refreshKeyPrice: h.refreshKeyPrice,
  currentKeyRef: h.currentKeyRef,
}));
vi.mock('../src/integrations/steam.js', () => ({ safeLoadMetal: h.safeLoadMetal }));
vi.mock('../src/risk/emergencyStop.js', () => ({ isStopped: h.isStopped }));
vi.mock('../src/events/publisher.js', () => ({ publish: h.publish, nowIso: () => 'now' }));
vi.mock('../src/watchlist/refreshWatchList.js', () => ({ getSkuName: h.getSkuName }));
vi.mock('../src/orderbook/orderBook.js', () => ({ getOrderBook: h.getOrderBook }));
vi.mock('../src/watchlist/overrides.js', () => ({
  loadOverrides: vi.fn().mockResolvedValue(0),
  getOverride: vi.fn(() => null),
  isSkuActive: () => true,
  effectiveCap: (_o: unknown, g: number) => g,
  effectiveRefBuy: (r: number) => r,
  effectiveRefSell: (r: number) => r,
}));
vi.mock('../src/risk/limits.js', () => ({ openPositionForSku: h.openPositionForSku }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runOnce, startListingRefresh, deleteAllOurListings, buildMarketSnapshot } from '../src/jobs/listingRefresh.js';
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
  h.env.SELL_MARKUP_PCT = 12;
  h.env.STALE_AUTOPRICE_PCT = 10;
  h.env.LIVE_MARKET_WEIGHT = 0.7;
  h.env.STRATEGY_MODE = 'arbitrage';
  h.env.MM_MAX_BUY_REF = undefined;
  h.env.MM_MIN_SPREAD_SCRAP = 1;
  h.env.TF2VAULT_RESERVE_REFINED = 0;
  h.isStopped.mockResolvedValue(false);
  h.openPositionForSku.mockResolvedValue(0);
  h.refreshKeyPrice.mockResolvedValue(63);
  h.currentKeyRef.mockReturnValue(63);
  h.listMyListings.mockResolvedValue([]);
  h.prisma.ourListing.findMany.mockResolvedValue([]);
  h.prisma.ourListing.create.mockResolvedValue({ id: 'row1' });
  h.prisma.ourListing.update.mockResolvedValue({});
  h.redis.smembers.mockResolvedValue([]);
  h.getSkuName.mockResolvedValue('Some Item');
  h.fetchAutoprice.mockResolvedValue({ skuKey: 'x', buyRef: 10, sellRef: 12 });
  h.createListing.mockResolvedValue({ bptfListingId: null, queued: true });
  h.deleteListing.mockResolvedValue(undefined);
  h.updateListingPrice.mockResolvedValue(undefined);
  h.safeLoadMetal.mockResolvedValue({ keys: 0, refined: 0, reclaimed: 0, scrap: 0, refinedTotal: 0 });
  // A sell floor must exist for evaluateListingBuyPrice to produce a price.
  // With autoprice buyRef=10 + sell floor 12 + discount 20%, desired buy = 8 ref
  // (same value the old computeBuyPrice produced), so the existing assertions hold.
  h.getOrderBook.mockResolvedValue({ buys: [], sells: [{ priceRef: 12 }] });
  // SELL loop is a no-op by default: bot owns nothing.
  h.prisma.inventoryItem.findMany.mockResolvedValue([]);
  h.prisma.inventoryItem.update.mockResolvedValue({});
  h.prisma.listing.findMany.mockResolvedValue([]);
  h.prisma.listing.create.mockResolvedValue({ id: 'sell1' });
  h.prisma.listing.update.mockResolvedValue({});
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

  it('3. three SKUs, none existing → 3 createListing + 3 pending updates (async)', async () => {
    h.redis.smembers.mockResolvedValue(['30;6', '35;6', '40;6']);
    await runOnce();
    expect(h.createListing).toHaveBeenCalledTimes(3);
    expect(h.prisma.ourListing.create).toHaveBeenCalledTimes(3);
    const pendingUpdates = h.prisma.ourListing.update.mock.calls.filter(
      (c) => (c[0] as { data?: { status?: string } }).data?.status === 'pending',
    );
    expect(pendingUpdates).toHaveLength(3);
  });

  it('4. existing at same price → skipped, no API calls', async () => {
    h.redis.smembers.mockResolvedValue(['30;6']);
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow({ priceRef: 8 })]);
    h.listMyListings.mockResolvedValue([{ bptfListingId: '111', intent: 'buy' }]);
    h.fetchAutoprice.mockResolvedValue({ buyRef: 10 }); // evaluateListingBuyPrice → 8 == existing
    await runOnce();
    expect(h.createListing).not.toHaveBeenCalled();
    expect(h.deleteListing).not.toHaveBeenCalled();
  });

  it('5. price drift > threshold → PATCH in place (no delete+recreate)', async () => {
    h.redis.smembers.mockResolvedValue(['30;6']);
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow({ priceRef: 8 })]);
    h.listMyListings.mockResolvedValue([{ bptfListingId: '111', intent: 'buy' }]);
    h.fetchAutoprice.mockResolvedValue({ buyRef: 12 }); // → 9.6 (min of 11.89 undercut, 9.6 discount), 20% drift
    await runOnce();
    // v2: update price on the same listing id, never delete+recreate.
    expect(h.updateListingPrice).toHaveBeenCalledTimes(1);
    expect(h.updateListingPrice.mock.calls[0][0]).toBe('111');
    expect(h.createListing).not.toHaveBeenCalled();
    expect(h.deleteListing).not.toHaveBeenCalled();
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

  it('12. refToKeysAndMetal(70) with key=63 → keys 1, metal 7.0 (63 scrap = 7 ref exactly)', () => {
    h.currentKeyRef.mockReturnValue(63);
    const r = refToKeysAndMetal(70);
    expect(r.keys).toBe(1);
    // 70 − 1 key (63) = 7 ref = 63 scrap → 7 ref + 0 scrap → 7.0 (carry, not 6.93)
    expect(r.metal).toBe(7.0);
  });

  it('13. createListing returns skipped → DB row failed, not pending', async () => {
    h.redis.smembers.mockResolvedValue(['30;6']);
    h.createListing.mockResolvedValue({ skipped: true, reason: 'invalid_defindex' });
    await runOnce();
    const failed = h.prisma.ourListing.update.mock.calls.find(
      (c) => (c[0] as { data?: { status?: string } }).data?.status === 'failed',
    );
    expect(failed).toBeDefined();
    const pending = h.prisma.ourListing.update.mock.calls.find(
      (c) => (c[0] as { data?: { status?: string } }).data?.status === 'pending',
    );
    expect(pending).toBeUndefined();
  });

  it('14. position cap reached → existing BUY listing retired (deleted on bp.tf + row closed)', async () => {
    h.redis.smembers.mockResolvedValue(['30;6']);
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow()]);
    h.listMyListings.mockResolvedValue([{ bptfListingId: '111', intent: 'buy' }]);
    h.openPositionForSku.mockResolvedValue(3); // held == MAX_POSITION_PER_SKU
    await runOnce();
    expect(h.deleteListing).toHaveBeenCalledWith('111');
    const closed = h.prisma.ourListing.update.mock.calls.find(
      (c) => (c[0] as { data?: { errorMessage?: string } }).data?.errorMessage === 'position_cap_reached',
    );
    expect(closed).toBeDefined();
    expect(h.createListing).not.toHaveBeenCalled();
  });

  it('bonus: deleteAllOurListings deletes every active listing', async () => {
    h.prisma.ourListing.findMany.mockResolvedValue([activeRow({ bptfListingId: '111' }), activeRow({ id: 'a2', bptfListingId: '222' })]);
    await deleteAllOurListings('manual');
    expect(h.deleteListing).toHaveBeenCalledWith('111');
    expect(h.deleteListing).toHaveBeenCalledWith('222');
  });
});

describe('buildMarketSnapshot — smart autoprice (trend protection)', () => {
  const meta = { defindex: 30, quality: 6, craftable: true };

  it('stale autoprice (sell floor > 10% below) → blends toward live floor', async () => {
    // autoprice 3.0, live floor 2.5 (drop 16.7% > 10%) → 2.5*0.7 + 3.0*0.3 = 2.65
    h.getSkuName.mockResolvedValue('Some Item');
    h.fetchAutoprice.mockResolvedValue({ buyRef: 3.0 });
    h.getOrderBook.mockResolvedValue({ buys: [], sells: [{ priceRef: 2.5 }] });
    const m = await buildMarketSnapshot('30;6', meta);
    expect(m).toEqual({ fairValueRef: 2.65, lowestSellRef: 2.5, highestBuyRef: null });
  });

  it('autoprice within tolerance (drop < 10%) → uses autoprice as fair value', async () => {
    // autoprice 3.0, live floor 2.9 (drop 3.3% < 10%) → fv = 3.0
    h.getSkuName.mockResolvedValue('Some Item');
    h.fetchAutoprice.mockResolvedValue({ buyRef: 3.0 });
    h.getOrderBook.mockResolvedValue({ buys: [], sells: [{ priceRef: 2.9 }] });
    const m = await buildMarketSnapshot('30;6', meta);
    expect(m?.fairValueRef).toBe(3.0);
  });

  it('no autoprice → order-book midpoint', async () => {
    h.getSkuName.mockResolvedValue(null); // no name → no autoprice lookup
    h.getOrderBook.mockResolvedValue({ buys: [{ priceRef: 2.0 }], sells: [{ priceRef: 2.5 }] });
    const m = await buildMarketSnapshot('30;6', meta);
    expect(m?.fairValueRef).toBe(2.25);
  });

  it('no autoprice and empty book → null', async () => {
    h.getSkuName.mockResolvedValue(null);
    h.getOrderBook.mockResolvedValue({ buys: [], sells: [] });
    const m = await buildMarketSnapshot('30;6', meta);
    expect(m).toBeNull();
  });
});
