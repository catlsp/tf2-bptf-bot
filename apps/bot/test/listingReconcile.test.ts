import { describe, it, expect, vi, beforeEach } from 'vitest';

// All I/O mocked. Exercises the real reconcileListings + real parseSku.

const h = vi.hoisted(() => ({
  env: { PAPER_LISTINGS: false } as Record<string, unknown>,
  prisma: { ourListing: { findMany: vi.fn(), update: vi.fn() } },
  logEvent: vi.fn(),
  getMyListings: vi.fn(),
}));

vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));
vi.mock('../src/integrations/db.js', () => ({ prisma: h.prisma, logEvent: h.logEvent }));
vi.mock('../src/integrations/bptf.js', () => ({ getMyListings: h.getMyListings }));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { reconcileListings } from '../src/jobs/listingReconcile.js';

function pendingRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p1',
    skuKey: '30;6',
    intent: 'buy',
    priceKeys: 0,
    priceMetal: 7.92,
    priceRef: 7.92,
    bptfListingId: null,
    status: 'pending',
    refreshedAt: new Date(),
    ...over,
  };
}

function remoteMatch(over: Partial<Record<string, unknown>> = {}) {
  return { id: 'real-123', intent: 0, defindex: 30, quality: 6, craftable: true, keys: 0, metal: 7.92, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.ourListing.findMany.mockResolvedValue([]);
  h.prisma.ourListing.update.mockResolvedValue({});
  h.getMyListings.mockResolvedValue([]);
});

describe('listingReconcile', () => {
  it('no pending → does not hit bp.tf', async () => {
    h.prisma.ourListing.findMany.mockResolvedValue([]);
    await reconcileListings();
    expect(h.getMyListings).not.toHaveBeenCalled();
    expect(h.prisma.ourListing.update).not.toHaveBeenCalled();
  });

  it('pending matches remote → bptfListingId set + status active', async () => {
    h.prisma.ourListing.findMany.mockResolvedValue([pendingRow()]);
    h.getMyListings.mockResolvedValue([remoteMatch({ id: 'real-123' })]);
    await reconcileListings();
    expect(h.prisma.ourListing.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { bptfListingId: 'real-123', status: 'active' },
    });
  });

  it('no match + older than 10 min → status failed', async () => {
    h.prisma.ourListing.findMany.mockResolvedValue([pendingRow({ refreshedAt: new Date(Date.now() - 11 * 60_000) })]);
    h.getMyListings.mockResolvedValue([]); // nothing matches
    await reconcileListings();
    expect(h.prisma.ourListing.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { status: 'failed' } });
  });

  it('no match but younger than 10 min → left pending (no update)', async () => {
    h.prisma.ourListing.findMany.mockResolvedValue([pendingRow({ refreshedAt: new Date(Date.now() - 60_000) })]);
    h.getMyListings.mockResolvedValue([]);
    await reconcileListings();
    expect(h.prisma.ourListing.update).not.toHaveBeenCalled();
  });

  it('price mismatch → not matched', async () => {
    h.prisma.ourListing.findMany.mockResolvedValue([pendingRow({ priceMetal: 7.92, refreshedAt: new Date() })]);
    h.getMyListings.mockResolvedValue([remoteMatch({ metal: 8.03 })]); // different price
    await reconcileListings();
    expect(h.prisma.ourListing.update).not.toHaveBeenCalled();
  });
});
