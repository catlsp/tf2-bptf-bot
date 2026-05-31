import type { TradeDecision } from '@bptf/types';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { recordPaperTrade, sendRealOffer } from './tradeExecutor.js';
import { underDailyCap, underPositionCap } from '../risk/limits.js';
import { isStopped } from '../risk/emergencyStop.js';
import { publish, nowIso } from '../events/publisher.js';
import { logEvent } from '../integrations/db.js';

// Acts on a BUY decision. In Phase 1 this only logs a paper trade after the same
// risk gates a real buy would face, so the paper P&L is realistic.

export async function handleBuyDecision(decision: TradeDecision): Promise<void> {
  if (await isStopped()) {
    logger.warn({ sku: decision.skuKey }, 'buy skipped: emergency stop active');
    return;
  }
  if (!(await underPositionCap(decision.skuKey))) {
    logger.info({ sku: decision.skuKey }, `buy skipped: position cap (${env.MAX_POSITION_PER_SKU})`);
    return;
  }
  if (!(await underDailyCap())) {
    logger.info('buy skipped: daily trade cap reached');
    return;
  }

  if (env.PAPER_TRADING) {
    const tradeId = await recordPaperTrade(decision);
    await logEvent({
      type: 'paper.buy',
      level: 'info',
      message: `paper BUY ${decision.name} @ ${decision.priceRef} ref`,
      payload: { tradeId, ...decision },
    });
    await publish({ type: 'paper.trade', level: 'info', at: nowIso(), decision });
    return;
  }

  // Phase 3: real outbound buy offer.
  await sendRealOffer(decision);
}
