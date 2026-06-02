import type { TradeDecision } from '@bptf/types';
import { randomUUID } from 'node:crypto';
import { env } from '../config/index.js';
import { prisma } from '../integrations/db.js';
import { logger } from '../lib/logger.js';
import { PaperGuardError } from '../lib/errors.js';
import { buildSkuKey } from '../lib/utils.js';
import { getOrCreateItemId } from '../persistence/items.js';

// Single chokepoint for turning a decision into a Trade row. In Phase 1 every
// path lands here in PAPER mode: we persist a PENDING hypothetical trade and
// return. The real-send branch is deliberately gated and throws until the env
// var is flipped (Phase 3), so no Steam offer can leak out by accident.

/** Phase 1 entry point. Records the decision as a paper trade. */
export async function recordPaperTrade(decision: TradeDecision): Promise<string> {
  const itemId = await getOrCreateItemId(decision.skuKey, decision.name);
  const trade = await prisma.trade.create({
    data: {
      steamOfferId: `paper:${randomUUID()}`,
      partnerSteamId: decision.partnerSteamId ?? 'paper',
      itemId,
      intent: decision.intent,
      priceRef: decision.priceRef,
      fairValueRef: decision.fairValueRef,
      profitRef: decision.expectedProfitRef,
      status: 'PENDING',
    },
    select: { id: true },
  });
  logger.info(
    { tradeId: trade.id, sku: decision.skuKey, intent: decision.intent, price: decision.priceRef },
    'paper trade recorded',
  );
  return trade.id;
}

/**
 * Real outbound (taker) send. Guarded: PAPER_TRADING must be false.
 *
 * NOTE: a taker offer needs the counterpart's listing assetids, which the
 * scanner's TradeDecision does not carry. Rather than crash the real-mode
 * scanner, we record the intent (status FAILED, not sent) and return. The live
 * real-trade path for this market-making MVP is the MAKER side — our bp.tf
 * listings filled by inbound offers, handled in incomingTradeHandler.ts.
 */
export async function sendRealOffer(decision: TradeDecision): Promise<string> {
  if (env.PAPER_TRADING) throw new PaperGuardError('sendRealOffer');
  const itemId = await getOrCreateItemId(decision.skuKey, decision.name);
  const trade = await prisma.trade.create({
    data: {
      steamOfferId: `unsent:${randomUUID()}`,
      partnerSteamId: decision.partnerSteamId ?? 'unknown',
      itemId,
      intent: decision.intent,
      priceRef: decision.priceRef,
      fairValueRef: decision.fairValueRef,
      profitRef: decision.expectedProfitRef,
      status: 'FAILED',
      errorMessage: 'outbound taker send not plumbed (no counterpart listing assetids); use maker/incoming path',
    },
    select: { id: true },
  });
  logger.warn(
    { tradeId: trade.id, sku: decision.skuKey, intent: decision.intent },
    'sendRealOffer: outbound taker not plumbed — recorded FAILED (not sent). Maker fills happen via incomingTradeHandler.',
  );
  return trade.id;
}

export { buildSkuKey };
