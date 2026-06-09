import { describe, it, expect, vi, beforeEach } from 'vitest';

// Market-making BUY must be gated by liquid funds: if we can't afford the bid we
// skip the listing with a warning (not an error, not a crash). This drives the
// real runOnce() in market_making mode with a deliberately small wallet.
const h = vi.hoisted(() => ({
  warn: vi.fn(),
  env: {
    PAPER_LISTINGS: false,
    STRATEGY_MODE: 'market_making',
    MM_MAX_BUY_REF: undefined,
    MM_MIN_SPREAD_SCRAP: 1,
    WATCHLIST_MODE: 'manual',
    TF2VAULT_RESERVE_REFINED: 0,
    MAX_LISTINGS: 30,
    MAX_POSITION_PER_SKU: 3,
    WATCH_MAX_BUY_REF: 50,
    LISTING_PRICE_DRIFT_PCT: 2,
    LISTING_DETAILS_TEMPLATE: 'Bot offering {priceRef} ref',
    BPTF_LISTING_DELAY_MS: 0,
    LISTING_REFRESH_INTERVAL_SEC: 1800,
    SELL_MARKUP_PCT: 12,
    STALE_AUTOPRICE_PCT: 10,
    LIVE_MARKET_WEIGHT: 0.7,
    BUY_DISCOUNT_PCT: 8,
  } as Record<string, unknown>,
  prisma: {
    ourListing: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    inventoryItem: { findMany: vi.fn(), update: vi.fn() },
    listing: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
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
  getRefPrice: vi.fn(),
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
vi.mock('../src/pricing/priceOracle.js', () => ({ getRefPrice: h.getRefPrice }));
vi.mock('../src/watchlist/overrides.js', () => ({
  loadOverrides: vi.fn().mockResolvedValue(0),
  getOverride: vi.fn(() => null),
  isSkuActive: () => true,
  effectiveCap: (_o: unknown, g: number) => g,
  effectiveRefBuy: (r: number) => r,
  effectiveRefSell: (r: number) => r,
}));
vi.mock('../src/risk/limits.js', () => ({ openPositionForSku: vi.fn().mockResolvedValue(0) }));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } }));

import { runOnce } from '../src/jobs/listingRefresh.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.isStopped.mockResolvedValue(false);
  h.refreshKeyPrice.mockResolvedValue(63);
  h.listMyListings.mockResolvedValue([]);
  h.prisma.ourListing.findMany.mockResolvedValue([]);
  h.prisma.ourListing.create.mockResolvedValue({ id: 'row1' });
  h.prisma.ourListing.update.mockResolvedValue({});
  h.prisma.inventoryItem.findMany.mockResolvedValue([]);
  h.prisma.listing.findMany.mockResolvedValue([]);
  h.redis.smembers.mockResolvedValue(['725;6']);
  h.getSkuName.mockResolvedValue('Tour of Duty Ticket');
  // Competitive price = pricedb buy (26), spread 1 ref clears the min — so the bot
  // wants to bid 26 ref. The funds gate is what's under test here.
  h.getRefPrice.mockReturnValue({ skuKey: '725;6', buyRef: 26, sellRef: 27 });
  // ...but we only hold 12 ref of liquid metal.
  h.safeLoadMetal.mockResolvedValue({ keys: 1, refined: 12, reclaimed: 0, scrap: 0, refinedTotal: 12 });
});

describe('market-making BUY: insufficient funds', () => {
  it('skips the BUY listing (no create, no crash) when wallet < bid', async () => {
    await expect(runOnce()).resolves.toBeUndefined();
    expect(h.createListing).not.toHaveBeenCalled();
    expect(h.prisma.ourListing.create).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ skuKey: '725;6', desiredPriceRef: 26, availableRef: 12 }),
      expect.stringContaining('insufficient funds'),
    );
  });

  it('creates the BUY listing once the wallet can cover the bid', async () => {
    h.safeLoadMetal.mockResolvedValue({ keys: 0, refined: 30, reclaimed: 0, scrap: 0, refinedTotal: 30 });
    h.createListing.mockResolvedValue({ bptfListingId: '999', queued: false });
    await runOnce();
    expect(h.createListing).toHaveBeenCalledTimes(1);
    const arg = h.createListing.mock.calls[0][0] as { intent: string; priceMetal: number };
    expect(arg.intent).toBe('buy');
  });
});
