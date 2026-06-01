import { env } from '../config/index.js';
import { prisma } from '../integrations/db.js';
import { manager } from '../integrations/steam.js';
import { currentKeyRef } from '../integrations/bptf.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { round2 } from '../lib/utils.js';

// Inbound trade-offer handling for the maker side: someone sends us an offer to
// fill one of our active classifieds listings. We validate it against the DB and
// auto-accept only exact matches (right item + right price). Everything else is
// declined. The real Steam accept/decline is gated by PAPER_TRADING.
//
// The matching logic (evaluateIncomingOffer) is a pure function so it can be
// unit-tested without Steam. Orchestration (normalize → load listings → decide →
// accept/decline → settle) lives in handleIncomingOffer.

const KEY_NAMES = new Set(['Mann Co. Supply Crate Key']);
const METAL_VALUE: Record<string, number> = {
  'Refined Metal': 1,
  'Reclaimed Metal': 1 / 3,
  'Scrap Metal': 1 / 9,
};

/** Our active listings, flattened to what the matcher needs. */
export interface ListingView {
  listingId: string;
  intent: 'sell' | 'buy';
  skuKey: string;
  /** SELL only: the inventory asset we're selling. */
  assetId?: string;
  priceRef: number;
}

/** A normalized inbound offer (Steam econ items collapsed to what we match on). */
export interface OfferView {
  offerId: string;
  partnerSteamId: string;
  /** assetids the offer takes FROM us (we give). */
  ourItemAssetIds: string[];
  /** non-currency item skus the partner gives us. */
  theirItemSkus: string[];
  /** ref value of currency the partner gives us. */
  currencyRefFromThem: number;
  /** ref value of currency we give the partner. */
  currencyRefToThem: number;
}

export type OfferDecision =
  | { action: 'accept'; intent: 'sell' | 'buy'; listingId: string; reason: string }
  | { action: 'decline'; reason: string; listingId?: string };

const EPS = 1e-9;

/**
 * Pure matcher. Decide whether an inbound offer exactly fills one of our active
 * listings. SELL: the partner takes our listed asset and pays at least the asking
 * price (and takes nothing extra). BUY: the partner gives us the item we're
 * buying and we pay no more than our bid.
 */
export function evaluateIncomingOffer(offer: OfferView, listings: ListingView[]): OfferDecision {
  // --- SELL listings: partner takes our listed asset ---
  for (const l of listings) {
    if (l.intent !== 'sell' || !l.assetId) continue;
    if (!offer.ourItemAssetIds.includes(l.assetId)) continue;

    // They must take ONLY the listed asset — nothing else of ours.
    if (offer.ourItemAssetIds.length > 1) {
      return { action: 'decline', reason: 'item_mismatch_extra_items_requested', listingId: l.listingId };
    }
    // And pay at least the asking price in currency.
    if (offer.currencyRefFromThem + EPS < l.priceRef) {
      return { action: 'decline', reason: 'price_too_low', listingId: l.listingId };
    }
    return { action: 'accept', intent: 'sell', listingId: l.listingId, reason: 'sell_filled' };
  }

  // --- BUY listings: partner gives us the item we're bidding on ---
  for (const l of listings) {
    if (l.intent !== 'buy') continue;
    if (!offer.theirItemSkus.includes(l.skuKey)) continue;
    if (offer.currencyRefToThem > l.priceRef + EPS) {
      return { action: 'decline', reason: 'we_would_overpay', listingId: l.listingId };
    }
    return { action: 'accept', intent: 'buy', listingId: l.listingId, reason: 'buy_filled' };
  }

  return { action: 'decline', reason: 'no_matching_listing' };
}

/** Sum the ref value of currency items (keys + metal) in a list of econ items. */
export function valueCurrencyRef(items: Array<{ market_hash_name?: string; name?: string }>): number {
  const keyRef = currentKeyRef();
  let ref = 0;
  for (const it of items) {
    const name = it.market_hash_name || it.name || '';
    if (KEY_NAMES.has(name)) ref += keyRef;
    else if (name in METAL_VALUE) ref += METAL_VALUE[name]!;
  }
  return round2(ref);
}

// --- Steam offer normalization ---

interface SteamEconItem {
  assetid: string;
  market_hash_name?: string;
  name?: string;
  app_data?: { def_index?: string | number };
}
interface SteamOffer {
  id: string;
  partner: { getSteamID64(): string };
  itemsToGive: SteamEconItem[]; // items WE give
  itemsToReceive: SteamEconItem[]; // items WE receive
  accept(cb: (err: Error | null, status?: string) => void): void;
  decline(cb: (err: Error | null) => void): void;
}

function normalizeOffer(offer: SteamOffer): OfferView {
  const give = offer.itemsToGive ?? [];
  const receive = offer.itemsToReceive ?? [];
  const isCurrency = (i: SteamEconItem) => {
    const n = i.market_hash_name || i.name || '';
    return KEY_NAMES.has(n) || n in METAL_VALUE;
  };
  return {
    offerId: String(offer.id),
    partnerSteamId: offer.partner.getSteamID64(),
    ourItemAssetIds: give.filter((i) => !isCurrency(i)).map((i) => String(i.assetid)),
    theirItemSkus: receive
      .filter((i) => !isCurrency(i))
      .map((i) => (i.app_data?.def_index != null ? `${i.app_data.def_index};6` : (i.market_hash_name ?? ''))),
    currencyRefFromThem: valueCurrencyRef(receive),
    currencyRefToThem: valueCurrencyRef(give),
  };
}

/** Load our active listings as ListingView[] (SELL assets come from LISTED inventory). */
async function loadActiveListings(): Promise<ListingView[]> {
  const views: ListingView[] = [];

  // SELL: each LISTED inventory item is reserved for a sell Listing.
  const listed = await prisma.inventoryItem.findMany({
    where: { status: 'LISTED', reservedFor: { not: null } },
    include: { item: { select: { skuKey: true } } },
  });
  const sellIds = listed.map((i) => i.reservedFor!).filter(Boolean);
  const sellListings = sellIds.length
    ? await prisma.listing.findMany({ where: { id: { in: sellIds }, intent: 'SELL', active: true } })
    : [];
  const priceById = new Map(sellListings.map((l) => [l.id, l.priceRef]));
  for (const inv of listed) {
    const price = priceById.get(inv.reservedFor!);
    if (price == null) continue;
    views.push({ listingId: inv.reservedFor!, intent: 'sell', skuKey: inv.item.skuKey, assetId: inv.assetId, priceRef: price });
  }

  // BUY: active buy listings, matched by item sku.
  const buyListings = await prisma.listing.findMany({
    where: { intent: 'BUY', active: true },
    include: { item: { select: { skuKey: true } } },
  });
  for (const l of buyListings) {
    views.push({ listingId: l.id, intent: 'buy', skuKey: l.item.skuKey, priceRef: l.priceRef });
  }

  return views;
}

/**
 * Settle an accepted SELL: the partner took our item and paid. Flip the inventory
 * row to SOLD, close the listing, and write a Trade with realized profit
 * (priceRef − acquiredPriceRef). Returns the created trade id, or null if the
 * listing/inventory could not be resolved.
 */
export async function settleAcceptedSell(
  listingId: string,
  offer: { offerId: string; partnerSteamId: string },
): Promise<string | null> {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) {
    logger.warn({ listingId }, 'settleAcceptedSell: listing not found');
    return null;
  }
  const inv = await prisma.inventoryItem.findFirst({ where: { reservedFor: listingId } });
  const costBasis = inv?.acquiredPriceRef ?? listing.fairValueRef;
  const profitRef = round2(listing.priceRef - costBasis);

  if (inv) {
    await prisma.inventoryItem.update({ where: { id: inv.id }, data: { status: 'SOLD', reservedFor: null } });
  }
  await prisma.listing.update({
    where: { id: listingId },
    data: { active: false, closedAt: new Date(), closedReason: 'sold' },
  });
  const trade = await prisma.trade.create({
    data: {
      steamOfferId: offer.offerId,
      partnerSteamId: offer.partnerSteamId,
      itemId: listing.itemId,
      intent: 'SELL',
      priceRef: listing.priceRef,
      fairValueRef: listing.fairValueRef,
      profitRef,
      status: 'ACCEPTED',
      completedAt: new Date(),
    },
    select: { id: true },
  });
  logger.info({ listingId, tradeId: trade.id, profitRef }, 'sell settled: inventory SOLD, trade recorded');
  return trade.id;
}

/** Orchestrator wired to the Steam manager's `newOffer` event. */
async function handleIncomingOffer(rawOffer: SteamOffer): Promise<void> {
  const offer = normalizeOffer(rawOffer);
  try {
    const listings = await loadActiveListings();
    const decision = evaluateIncomingOffer(offer, listings);
    logger.info({ offerId: offer.offerId, decision }, 'incoming offer evaluated');

    if (decision.action === 'decline') {
      if (!env.PAPER_TRADING) {
        await new Promise<void>((resolve) => rawOffer.decline(() => resolve()));
      }
      return;
    }

    // accept
    if (env.PAPER_TRADING) {
      logger.warn({ offerId: offer.offerId }, 'PAPER_TRADING — would accept, not touching Steam');
    } else {
      await new Promise<void>((resolve, reject) =>
        rawOffer.accept((err) => (err ? reject(err) : resolve())),
      );
    }

    if (decision.intent === 'sell') {
      await settleAcceptedSell(decision.listingId, offer);
    } else {
      logger.info({ offerId: offer.offerId, listingId: decision.listingId }, 'buy fill accepted (settlement TODO)');
    }
  } catch (e) {
    logger.error({ err: errMessage(e), offerId: offer.offerId }, 'failed to handle incoming offer');
  }
}

let attached = false;
/** Attach the live `newOffer` listener. Idempotent. */
export function startIncomingOffers(): void {
  if (attached) return;
  attached = true;
  manager.on('newOffer', (offer: SteamOffer) => void handleIncomingOffer(offer));
  logger.info({ paper: env.PAPER_TRADING }, 'incoming offer listener attached');
}
