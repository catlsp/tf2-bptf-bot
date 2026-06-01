import { describe, it, expect, vi, beforeEach } from 'vitest';

// incomingTradeHandler imports steam (manager), bptf (currentKeyRef), db (prisma)
// and config — all mocked so the matcher + settlement run without Steam or a DB.
const h = vi.hoisted(() => ({
  env: { PAPER_TRADING: true, MM_MAX_BUY_REF: undefined as number | undefined, MM_MIN_SPREAD_SCRAP: 1 } as Record<string, unknown>,
  prisma: {
    listing: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    inventoryItem: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    trade: { create: vi.fn() },
  },
  currentKeyRef: vi.fn(() => 63),
  manager: { on: vi.fn() },
}));
vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));
vi.mock('../src/integrations/db.js', () => ({ prisma: h.prisma }));
vi.mock('../src/integrations/steam.js', () => ({ manager: h.manager }));
vi.mock('../src/integrations/bptf.js', () => ({ currentKeyRef: h.currentKeyRef }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { evaluateIncomingOffer, settleAcceptedSell, type ListingView, type OfferView } from '../src/trading/incomingTradeHandler.js';
import { evaluateMarketMakingBuy, evaluateMarketMakingSell } from '../src/pricing/strategy.js';

const SELL_LISTING: ListingView = { listingId: 'L1', intent: 'sell', skuKey: '725;6', assetId: 'A1', priceRef: 24 };

function offer(over: Partial<OfferView>): OfferView {
  return {
    offerId: 'o1',
    partnerSteamId: 'partner',
    ourItemAssetIds: [],
    theirItemSkus: [],
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
    expect(d).toEqual({ action: 'accept', intent: 'sell', listingId: 'L1', reason: 'sell_filled' });
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
    const ob = { buys: [{ priceRef: 70.55 }, { priceRef: 70.44 }, { priceRef: 70.33 }], sells: [{ priceRef: 72.11 }, { priceRef: 72.22 }, { priceRef: 72.33 }] };

    // 1. Market-making prices.
    const buyPrice = evaluateMarketMakingBuy(ob);
    expect(buyPrice).toBe(70.66);
    const costBasis = 70.66; // we own a key acquired at our own bid
    const sellPrice = evaluateMarketMakingSell(ob, costBasis);
    expect(sellPrice).toBe(72.0);

    // 2. Inbound offer that fills our SELL listing at the ask.
    const sell: ListingView = { listingId: 'L1', intent: 'sell', skuKey: '5021;6', assetId: 'A1', priceRef: sellPrice! };
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
