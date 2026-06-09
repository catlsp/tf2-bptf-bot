import { describe, it, expect, vi, beforeEach } from 'vitest';

// incomingTradeHandler imports steam (manager), bptf (currentKeyRef), db (prisma)
// and config — all mocked so the matcher + settlement run without Steam or a DB.
const h = vi.hoisted(() => ({
  env: { PAPER_TRADING: true, MM_MAX_BUY_REF: undefined as number | undefined, MM_MIN_SPREAD_SCRAP: 1 } as Record<string, unknown>,
  prisma: {
    ourListing: { findUnique: vi.fn(), findMany: vi.fn() },
    listing: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    item: { upsert: vi.fn() },
    inventoryItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    trade: { create: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  currentKeyRef: vi.fn(() => 63),
  manager: { on: vi.fn() },
}));
vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));
vi.mock('../src/integrations/db.js', () => ({ prisma: h.prisma, logEvent: vi.fn() }));
vi.mock('../src/integrations/steam.js', () => ({
  manager: h.manager,
  confirmOffer: vi.fn().mockResolvedValue(undefined),
  sortBackpack: vi.fn(),
  relogGame: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/jobs/listingRefresh.js', () => ({ runOnce: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/integrations/bptf.js', () => ({ currentKeyRef: h.currentKeyRef }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  evaluateIncomingOffer,
  settleAcceptedSell,
  settleAcceptedBuy,
  type ListingView,
  type OfferView,
} from '../src/trading/incomingTradeHandler.js';
import { priceCompetitiveBuy, priceCompetitiveSell } from '../src/pricing/strategy.js';

const SELL_LISTING: ListingView = { source: 'listing', listingId: 'L1', intent: 'sell', skuKey: '725;6', assetId: 'A1', priceRef: 24 };

function offer(over: Partial<OfferView>): OfferView {
  return {
    offerId: 'o1',
    partnerSteamId: 'partner',
    ourItemAssetIds: [],
    theirItemSkus: [],
    theirItemAssetIds: [],
    currencyRefFromThem: 0,
    currencyRefToThem: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.trade.create.mockResolvedValue({ id: 't1' });
  h.prisma.listing.update.mockResolvedValue({});
  h.prisma.inventoryItem.update.mockResolvedValue({});
});

describe('evaluateIncomingOffer', () => {
  it('valid matching offer → accept', () => {
    const d = evaluateIncomingOffer(offer({ ourItemAssetIds: ['A1'], currencyRefFromThem: 24 }), [SELL_LISTING]);
    expect(d).toEqual({ action: 'accept', intent: 'sell', source: 'listing', listingId: 'L1', reason: 'sell_filled' });
  });

  it('wrong price → decline', () => {
    const d = evaluateIncomingOffer(offer({ ourItemAssetIds: ['A1'], currencyRefFromThem: 20 }), [SELL_LISTING]);
    expect(d).toMatchObject({ action: 'decline', reason: 'price_too_low', listingId: 'L1' });
  });

  it('wrong item (takes an extra item we did not list) → decline', () => {
    const d = evaluateIncomingOffer(offer({ ourItemAssetIds: ['A1', 'K1'], currencyRefFromThem: 24 }), [SELL_LISTING]);
    expect(d.action).toBe('decline');
    expect((d as { reason: string }).reason).toContain('item_mismatch');
  });

  it('no matching listing → decline', () => {
    const d = evaluateIncomingOffer(offer({ ourItemAssetIds: ['Z9'], currencyRefFromThem: 24 }), [SELL_LISTING]);
    expect(d).toEqual({ action: 'decline', reason: 'no_matching_listing' });
  });
});

describe('PAPER round-trip: MM prices → fill → settle', () => {
  it('5021;6: buy 70.66, sell 72.00, incoming offer fills sell, inventory SOLD + trade profit 1.34', async () => {
    // 1. Competitive prices off the pricedb reference (buy 70.66 / sell 72.00).
    const buyPrice = priceCompetitiveBuy({ refBuyRef: 70.66, refSellRef: 72.0, maxBuyCapRef: 1000, minSpreadScrap: 1 });
    expect(buyPrice).toBe(70.66);
    const costBasis = 70.66; // we own a key acquired at our own bid
    const sellPrice = priceCompetitiveSell(72.0, costBasis, 1);
    expect(sellPrice).toBe(72.0);

    // 2. Inbound offer that fills our SELL listing at the ask.
    const sell: ListingView = { source: 'listing', listingId: 'L1', intent: 'sell', skuKey: '5021;6', assetId: 'A1', priceRef: sellPrice! };
    const decision = evaluateIncomingOffer(offer({ ourItemAssetIds: ['A1'], currencyRefFromThem: 72.0 }), [sell]);
    expect(decision).toMatchObject({ action: 'accept', intent: 'sell', listingId: 'L1' });

    // 3. Settlement: LISTED → SOLD, Trade row with realized profit.
    h.prisma.listing.findUnique.mockResolvedValue({ id: 'L1', itemId: 'item1', priceRef: 72.0, fairValueRef: 72.11 });
    h.prisma.inventoryItem.findFirst.mockResolvedValue({ id: 'inv1', acquiredPriceRef: 70.66 });

    const tradeId = await settleAcceptedSell('L1', { offerId: 'o1', partnerSteamId: 'partner' });
    expect(tradeId).toBe('t1');

    expect(h.prisma.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inv1' }, data: expect.objectContaining({ status: 'SOLD' }) }),
    );
    const tradeArg = h.prisma.trade.create.mock.calls[0][0] as { data: { intent: string; priceRef: number; profitRef: number; status: string } };
    expect(tradeArg.data.intent).toBe('SELL');
    expect(tradeArg.data.priceRef).toBe(72.0);
    expect(tradeArg.data.profitRef).toBe(1.34);
    expect(tradeArg.data.status).toBe('ACCEPTED');
  });
});

describe('BUY fill: OurListing bid filled → HELD inventory + ACCEPTED BUY trade', () => {
  it('matches our OurListing BUY and settles inventory + trade', async () => {
    // 1. Our active maker BUY listing, surfaced from OurListing as a ListingView.
    const buyView: ListingView = { source: 'ourlisting', listingId: 'OL1', intent: 'buy', skuKey: '200;11', priceRef: 30 };

    // 2. Inbound offer: partner gives us the item (asset 'R7'), we pay <= our bid.
    const inbound = offer({ theirItemSkus: ['200;11'], theirItemAssetIds: ['R7'], currencyRefToThem: 30 });
    const decision = evaluateIncomingOffer(inbound, [buyView]);
    expect(decision).toEqual({ action: 'accept', intent: 'buy', source: 'ourlisting', listingId: 'OL1', reason: 'buy_filled' });

    // 3. Settlement reads OurListing (the BUY source of truth), upserts the Item,
    //    and writes a HELD InventoryItem + ACCEPTED BUY Trade in one transaction.
    h.prisma.trade.findUnique.mockResolvedValue(null);
    h.prisma.ourListing.findUnique.mockResolvedValue({ skuKey: '200;11', priceRef: 30, fairValueRef: 31 });
    h.prisma.item.upsert.mockResolvedValue({ id: 'item1' });
    h.prisma.inventoryItem.create.mockResolvedValue({ id: 'inv1' });
    h.prisma.$transaction.mockImplementation((fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));

    const tradeId = await settleAcceptedBuy('OL1', inbound);
    expect(tradeId).toBe('t1');

    expect(h.prisma.inventoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assetId: 'R7', itemId: 'item1', acquiredPriceRef: 30, status: 'HELD' }),
      }),
    );
    const tradeArg = h.prisma.trade.create.mock.calls[0][0] as { data: { intent: string; status: string; priceRef: number } };
    expect(tradeArg.data.intent).toBe('BUY');
    expect(tradeArg.data.status).toBe('ACCEPTED');
    expect(tradeArg.data.priceRef).toBe(30);

    // The standing bid is NOT closed here (it can fill again).
    expect(h.prisma.listing.update).not.toHaveBeenCalled();
  });
});
