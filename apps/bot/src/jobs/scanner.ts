import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { getActiveWatchlist } from '../watchlist/manager.js';
import { getMarketSnapshot } from '../pricing/fairValue.js';
import { evaluate } from '../pricing/strategy.js';
import { handleBuyDecision } from '../trading/buyer.js';
import { handleSellDecision } from '../trading/seller.js';
import { refreshKeyPrice } from '../integrations/bptf.js';
import { isStopped } from '../risk/emergencyStop.js';
import { publish, nowIso } from '../events/publisher.js';
import { logEvent } from '../integrations/db.js';

// Periodic market scan. Every SCANNER_INTERVAL_SEC: refresh key price, walk the
// watchlist, build a snapshot per SKU, run the strategy, and route any decision
// to the (paper) buyer/seller. The bp.tf client's internal limiter guarantees we
// never exceed 60 req/min even though each SKU makes 2 calls.

let running = false;
let timer: NodeJS.Timeout | null = null;

// rolling counters for /stats
export const stats = {
  scansRun: 0,
  lastScanAt: null as string | null,
  lastOpportunities: 0,
  totalOpportunities: 0,
};

async function scanOnce(): Promise<void> {
  if (running) {
    logger.warn('scan still in progress; skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  let opportunities = 0;

  try {
    if (await isStopped()) {
      logger.warn('scan skipped: emergency stop active');
      return;
    }

    await refreshKeyPrice();
    const watchlist = await getActiveWatchlist();
    logger.debug({ skus: watchlist.length }, 'scan started');

    for (const sku of watchlist) {
      try {
        const { market } = await getMarketSnapshot(sku);
        const decision = evaluate({ skuKey: sku.skuKey, name: sku.name, market });
        if (!decision) continue;

        opportunities++;
        logger.info(
          { sku: sku.skuKey, intent: decision.intent, profit: decision.expectedProfitRef, margin: decision.marginPct },
          `opportunity: ${decision.reason}`,
        );
        if (decision.intent === 'BUY') await handleBuyDecision(decision);
        else await handleSellDecision(decision);
      } catch (e) {
        logger.warn({ sku: sku.skuKey, err: errMessage(e) }, 'sku scan failed');
        await logEvent({ type: 'scan.skuError', level: 'warn', message: errMessage(e), payload: { sku: sku.skuKey } });
      }
    }

    const durationMs = Date.now() - startedAt;
    stats.scansRun++;
    stats.lastScanAt = nowIso();
    stats.lastOpportunities = opportunities;
    stats.totalOpportunities += opportunities;

    logger.debug({ skus: watchlist.length, opportunities, durationMs }, 'scan complete');
    await logEvent({ type: 'scan.completed', level: 'info', message: 'market scan complete', payload: { skus: watchlist.length, opportunities, durationMs } });
    await publish({ type: 'scan.completed', level: 'info', at: nowIso(), skusScanned: watchlist.length, opportunities, durationMs });
  } catch (e) {
    logger.error({ err: errMessage(e) }, 'scan failed');
    await publish({ type: 'error', level: 'error', at: nowIso(), scope: 'scanner', message: errMessage(e) });
  } finally {
    running = false;
  }
}

export function startScanner(): void {
  const intervalMs = env.SCANNER_INTERVAL_SEC * 1000;
  logger.info({ intervalSec: env.SCANNER_INTERVAL_SEC }, 'scanner scheduled');
  // kick one immediately, then on the interval
  void scanOnce();
  timer = setInterval(() => void scanOnce(), intervalMs);
}

export function stopScanner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
