import { prisma } from '../integrations/db.js';
import { env } from '../config/index.js';
import { redis } from '../integrations/redis.js';

// Position / volume / loss guards. In Phase 1 these gate whether a paper trade
// is even logged as actionable; Phase 5 wires the same checks into real sends.

/** Daily trade counter keyed by UTC date, so MAX_DAILY_TRADES resets at midnight. */
function dailyKey(): string {
  return `bptf:dailyTrades:${new Date().toISOString().slice(0, 10)}`;
}

export async function dailyTradeCount(): Promise<number> {
  return Number((await redis.get(dailyKey())) ?? 0);
}

export async function incrDailyTrade(): Promise<number> {
  const k = dailyKey();
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, 2 * 86_400);
  return n;
}

export async function underDailyCap(): Promise<boolean> {
  return (await dailyTradeCount()) < env.MAX_DAILY_TRADES;
}

/** How many of this SKU we already hold or have reserved/listed. */
export async function openPositionForSku(skuKey: string): Promise<number> {
  const item = await prisma.item.findUnique({ where: { skuKey }, select: { id: true } });
  if (!item) return 0;
  return prisma.inventoryItem.count({
    where: { itemId: item.id, status: { in: ['HELD', 'LISTED', 'RESERVED'] } },
  });
}

export async function underPositionCap(skuKey: string): Promise<boolean> {
  return (await openPositionForSku(skuKey)) < env.MAX_POSITION_PER_SKU;
}

/** Realized P&L today, summed from completed trades. Negative = loss. */
export async function dailyRealizedPnlRef(): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const rows = await prisma.trade.findMany({
    where: { completedAt: { gte: since }, status: 'ACCEPTED' },
    select: { profitRef: true },
  });
  return rows.reduce((acc, r) => acc + (r.profitRef ?? 0), 0);
}

/** True once today's loss breaches DAILY_LOSS_CUTOFF_PCT of starting capital. */
export async function lossCutoffBreached(): Promise<boolean> {
  const pnl = await dailyRealizedPnlRef();
  const cutoff = -(env.STARTING_CAPITAL_REF * env.DAILY_LOSS_CUTOFF_PCT) / 100;
  return pnl <= cutoff;
}
