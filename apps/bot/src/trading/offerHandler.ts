import { logger } from '../lib/logger.js';
import { env } from '../config/index.js';

// Inbound offer handling is Phase 4. CRITICAL: in Phase 1 we do NOT attach a
// newOffer listener, because this bot shares its Steam account with tf2vault-bot
// and tf2vault-bot already owns inbound-offer handling. Attaching here would make
// both processes race to accept/decline the same offer.
//
// This module is left as the seam for Phase 4 (value/item validation,
// auto-accept/decline, mobile confirmation) and is intentionally not wired up.

export function registerOfferHandler(): void {
  if (env.PAPER_TRADING) {
    logger.info('offer handler not attached (paper mode; tf2vault-bot owns inbound offers)');
    return;
  }
  logger.warn('inbound offer handling is implemented in Phase 4 — no-op for now');
}
