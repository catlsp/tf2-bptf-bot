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
 * BUY price from fair value: fairValueRef * (1 - BUY_DISCOUNT_PCT/100).
 * Returns null when fair value is missing/zero (cannot price safely).
 */
export function computeBuyPrice(fairValueRef: number | null): number | null {
  if (!fairValueRef || fairValueRef <= 0) return null;
  const discount = env.BUY_DISCOUNT_PCT / 100;
  return round2(fairValueRef * (1 - discount));
}

/** True when two prices differ by more than LISTING_PRICE_DRIFT_PCT. */
export function hasPriceDrifted(oldPriceRef: number, newPriceRef: number): boolean {
  if (oldPriceRef <= 0) return true;
  const driftPct = (Math.abs(newPriceRef - oldPriceRef) / oldPriceRef) * 100;
  return driftPct > env.LISTING_PRICE_DRIFT_PCT;
}
