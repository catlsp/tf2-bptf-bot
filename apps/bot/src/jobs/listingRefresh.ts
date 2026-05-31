import { logger } from '../lib/logger.js';
import { env } from '../config/index.js';

// Phase 2: bump/repost our active bp.tf listings every ~30 min and apply the
// age-based discount ladder (see pricing/ageBasedDiscount.ts). No listings exist
// in Phase 1 (paper mode), so this is a documented no-op seam.

export function startListingRefresh(): void {
  if (env.PAPER_TRADING) {
    logger.info('listing refresh disabled (paper mode)');
    return;
  }
  logger.warn('listing refresh is implemented in Phase 2 — no-op for now');
}
