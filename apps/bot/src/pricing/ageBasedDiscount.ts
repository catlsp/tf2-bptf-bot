import { env } from '../config/index.js';
import { applyDiscount, round2 } from '../lib/utils.js';

// Stuck-inventory discount ladder (Phase 2 applies it to live listings; defined
// here so the rule lives with the rest of pricing). After MAX_HOLD_DAYS, drop
// 5% every 2 days until sold, never below a floor of the original buy price.

const DROP_PCT_PER_STEP = 5;
const DAYS_PER_STEP = 2;

export function discountedPrice(opts: {
  basePriceRef: number;
  acquiredPriceRef: number;
  acquiredAt: Date;
  now?: Date;
}): { priceRef: number; steps: number } {
  const now = opts.now ?? new Date();
  const ageDays = (now.getTime() - opts.acquiredAt.getTime()) / 86_400_000;
  if (ageDays <= env.MAX_HOLD_DAYS) return { priceRef: opts.basePriceRef, steps: 0 };

  const steps = Math.floor((ageDays - env.MAX_HOLD_DAYS) / DAYS_PER_STEP) + 1;
  let price = opts.basePriceRef;
  for (let i = 0; i < steps; i++) price = applyDiscount(price, DROP_PCT_PER_STEP);

  // never sell below what we paid (no realized loss from the discount ladder alone)
  const floored = Math.max(round2(price), opts.acquiredPriceRef);
  return { priceRef: floored, steps };
}
