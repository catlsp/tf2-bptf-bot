import type { TradeDecision } from '@bptf/types';
import { randomUUID } from 'node:crypto';
import { env } from '../config/index.js';
import { prisma } from '../integrations/db.js';
import { logger } from '../lib/logger.js';
import { PaperGuardError } from '../lib/errors.js';
import { buildSkuKey, defindexFromSkuKey } from '../lib/utils.js';

// Single chokepoint for turning a decision into a Trade row. In Phase 1 every
// path lands here in PAPER mode: we persist a PENDING hypothetical trade and
// return. The real-send branch is deliberately gated and throws until the env
// var is flipped (Phase 3), so no Steam offer can leak out by accident.

async function upsertItemForDecision(decision: TradeDecision): Promise<string> {
  const defindex = defindexFromSkuKey(decision.skuKey);
  const parts = decision.skuKey.split(';');
  const quality = Number(parts[1] ?? 6);
  const item = await prisma.item.upsert({
    where: { skuKey: decision.skuKey },
    create: {
      skuKey: decision.skuKey,
      defindex,
      quality,
      craftable: !parts.includes('uncraftable'),
      killstreak: 0,
      australium: parts.includes('australium'),
      name: decision.name,
    },
    update: { name: decision.name },
    select: { id: true },
  });
  return item.id;
}

/** Phase 1 entry point. Records the decision as a paper trade. */
export async function recordPaperTrade(decision: TradeDecision): Promise<string> {
  const itemId = await upsertItemForDecision(decision);
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
 * Phase 3 real send. Guarded twice: PAPER_TRADING must be false AND the caller
 * must opt in. Left intentionally unimplemented for Phase 1.
 */
export async function sendRealOffer(_decision: TradeDecision): Promise<never> {
  if (env.PAPER_TRADING) throw new PaperGuardError('sendRealOffer');
  throw new Error('real offer sending is implemented in Phase 3');
}

export { buildSkuKey };
