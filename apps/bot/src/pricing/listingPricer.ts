import { env } from '../config/index.js';
import { round2 } from '../lib/utils.js';
import { currentKeyRef } from '../integrations/bptf.js';

// Pure pricing helpers for Phase 2 BUY listings. No I/O except reading the
// cached key price.

// TF2 metal: 1 refined = 9 scrap. bp.tf renders metal as `ref.scrap`, where the
// two decimals encode 0..8 scrap (scrap × 0.11) and every 9th scrap CARRIES into
// a refined. So 17 scrap is 1 ref + 8 scrap = 1.88, not 17 × 0.11 = 1.87.
const SCRAP_PER_REF = 9;

/**
 * Convert a refined-denominated price into the (keys, metal) shape bp.tf expects.
 * Metal is snapped to bp.tf's scrap grid via {@link quantizeForDisplay} so the
 * value we POST is exactly what bp.tf renders — no card/description drift.
 */
export function refToKeysAndMetal(priceRef: number): { keys: number; metal: number } {
  const keyRef = currentKeyRef();
  const keys = keyRef > 0 ? Math.floor(priceRef / keyRef) : 0;
  const metalRaw = priceRef - keys * keyRef;
  return { keys, metal: quantizeForDisplay(metalRaw) };
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
 * Snap a refined amount onto bp.tf's scrap grid and render it in `ref.scrap`
 * notation. Rounds to the NEAREST whole scrap (recovers grid values like 1.88,
 * whose 8 scrap = 0.888… reads back as 0.88 → 8 scrap, not 7), then carries every
 * 9th scrap into a refined. This is the single source of truth for both the metal
 * we POST and the price shown in the description, so they can never disagree:
 *   1.88 ref → round(16.92)=17 scrap → 1 ref + 8 scrap → 1.88
 *   7.00 ref → 63 scrap            → 7 ref + 0 scrap → 7.00
 */
export function quantizeForDisplay(metalRef: number): number {
  if (metalRef <= 0) return 0;
  const totalScrap = Math.round(metalRef * SCRAP_PER_REF);
  const ref = Math.floor(totalScrap / SCRAP_PER_REF);
  const scrap = totalScrap % SCRAP_PER_REF;
  return round2(ref + scrap * 0.11);
}

/** True when two prices differ by more than LISTING_PRICE_DRIFT_PCT. */
export function hasPriceDrifted(oldPriceRef: number, newPriceRef: number): boolean {
  if (oldPriceRef <= 0) return true;
  const driftPct = (Math.abs(newPriceRef - oldPriceRef) / oldPriceRef) * 100;
  return driftPct > env.LISTING_PRICE_DRIFT_PCT;
}
