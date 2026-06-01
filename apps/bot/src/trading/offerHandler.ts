import { logger } from '../lib/logger.js';
import { env } from '../config/index.js';
import { startIncomingOffers } from './incomingTradeHandler.js';

// Attach inbound trade-offer handling. This Steam account is dedicated to this
// bot (not shared), so we own inbound offers here. The listener validates each
// offer against our active listings and auto-accepts exact matches; real Steam
// accept/decline is gated by PAPER_TRADING inside the handler.

export function registerOfferHandler(): void {
  startIncomingOffers();
  if (env.PAPER_TRADING) {
    logger.info('offer handler attached in PAPER_TRADING mode — evaluates + logs, never touches Steam');
  } else {
    logger.warn('offer handler attached LIVE — matching offers will be auto-accepted on Steam');
  }
}
