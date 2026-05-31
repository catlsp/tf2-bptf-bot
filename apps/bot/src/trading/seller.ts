import type { TradeDecision } from '@bptf/types';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { recordPaperTrade } from './tradeExecutor.js';
import { isStopped } from '../risk/emergencyStop.js';
import { publish, nowIso } from '../events/publisher.js';
import { logEvent } from '../integrations/db.js';

// Acts on a SELL decision. Phase 1: paper only. Phase 2 will create real bp.tf
// listings here (listing creation, no inventory movement yet); Phase 3 hits buy
// orders directly. For now we log the hypothetical sell.

export async function handleSellDecision(decision: TradeDecision): Promise<void> {
  if (await isStopped()) {
    logger.warn({ sku: decision.skuKey }, 'sell skipped: emergency stop active');
    return;
  }

  if (env.PAPER_TRADING) {
    const tradeId = await recordPaperTrade(decision);
    await logEvent({
      type: 'paper.sell',
      level: 'info',
      message: `paper SELL ${decision.name} @ ${decision.priceRef} ref`,
      payload: { tradeId, ...decision },
    });
    await publish({ type: 'paper.trade', level: 'info', at: nowIso(), decision });
    return;
  }

  // Phase 2/3: create listing / hit buy order.
  logger.warn({ sku: decision.skuKey }, 'real selling not implemented before Phase 2');
}
