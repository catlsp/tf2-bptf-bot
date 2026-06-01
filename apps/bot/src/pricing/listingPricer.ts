import { env } from '../config/index.js';
import { round2 } from '../lib/utils.js';
import { currentKeyRef } from '../integrations/bptf.js';

// Pure pricing helpers for Phase 2 BUY listings. No I/O except reading the
// cached key price.

/**
 * Convert a refined-denominated price into the (keys, metal) shape bp.tf expects.
 * Metal is in 0.11 increments (1 scrap = 0.11 ref); we round DOWN so we never
 * overpay on a buy order.
 */
export function refToKeysAndMetal(priceRef: number): { keys: number; metal: number } {
  const keyRef = currentKeyRef();
  if (keyRef <= 0) {
    return { keys: 0, metal: roundToScrap(priceRef) };
  }
  const keys = Math.floor(priceRef / keyRef);
  const metalRaw = priceRef - keys * keyRef;
  return { keys, metal: roundToScrap(metalRaw) };
}

function roundToScrap(metalRef: number): number {
  const scrapCount = Math.floor(metalRef / 0.11 + 1e-9);
  return round2(scrapCount * 0.11);
}

/**
 * @deprecated Use `evaluateListingBuyPrice()` from `pricing/strategy.ts`. This
 * naive `fairValue * (1 - BUY_DISCOUNT_PCT)` ignored the live sell floor and the
 * competing buy orders, so it produced listings far below market that never
 * filled. Kept for back-compat only; not imported by listingRefresh anymore.
 */
export function computeBuyPrice(fairValueRef: number | null): number | null {
  if (!fairValueRef || fairValueRef <= 0) return null;
  const discount = env.BUY_DISCOUNT_PCT / 100;
  return round2(fairValueRef * (1 - discount));
}

/**
 * Mirror bp.tf's scrap-grid rendering. bp.tf shows metal in the TF2 notation
 * `ref.scrap` where the decimals encode whole scrap (1 scrap = 0.11, 9 scrap =
 * 1 ref) and any sub-scrap remainder is floored — e.g. a sent metal of 2.30 is
 * 2 ref + 2.7 scrap, which renders as 2.22 (2 ref + 2 scrap). We floor to match
 * exactly what a trader sees on the listing card, so the description text never
 * disagrees with the price card.
 */
export function quantizeForDisplay(metalRef: number): number {
  if (metalRef <= 0) return 0;
  const refPart = Math.floor(metalRef + 1e-9);
  const scrap = Math.floor((metalRef - refPart) * 9 + 1e-9); // 0..8 whole scrap
  return round2(refPart + scrap * 0.11);
}

/** True when two prices differ by more than LISTING_PRICE_DRIFT_PCT. */
export function hasPriceDrifted(oldPriceRef: number, newPriceRef: number): boolean {
  if (oldPriceRef <= 0) return true;
  const driftPct = (Math.abs(newPriceRef - oldPriceRef) / oldPriceRef) * 100;
  return driftPct > env.LISTING_PRICE_DRIFT_PCT;
}
