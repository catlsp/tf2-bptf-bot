import { env } from './config/index.js';
import { logger } from './lib/logger.js';
import { errMessage } from './lib/errors.js';
import { connectRedis, disconnectRedis } from './integrations/redis.js';
import { connectDb } from './integrations/db.js';
import { startSteam } from './integrations/steam.js';
import { initEmergencyStop } from './risk/emergencyStop.js';
import { ensureSeeded } from './watchlist/manager.js';
import { registerOfferHandler } from './trading/offerHandler.js';
import { startScanner, stopScanner } from './jobs/scanner.js';
import { startInventorySync, publishBalanceSummary } from './jobs/inventorySync.js';
import { startListingRefresh, stopListingRefresh } from './jobs/listingRefresh.js';
import { startListingReconcile, stopListingReconcile } from './jobs/listingReconcile.js';
import { initOrderBook, loadWatchList } from './orderbook/orderBook.js';
import { startWatchListScheduler, stopWatchListScheduler } from './watchlist/refreshWatchList.js';
import * as bptfWs from './ws/bptfWs.js';

// Sole entry point. Boots infra, logs in to Steam, then starts the periodic
// jobs. Mirrors bot.js's top-level wiring but gated behind a single async main()
// so nothing runs on import.

async function main(): Promise<void> {
  logger.info(
    { paper: env.PAPER_TRADING, node: process.version, reserveKeys: env.TF2VAULT_RESERVE_KEYS, reserveRef: env.TF2VAULT_RESERVE_REFINED },
    'bptf-bot starting',
  );
  if (!env.PAPER_TRADING) {
    logger.warn('PAPER_TRADING is FALSE — this process can send real Steam offers');
  }

  await connectRedis();
  await connectDb();
  await initEmergencyStop();
  await ensureSeeded();

  // --- PR2: real-time order book + dynamic watch list ---
  initOrderBook(); // register Redis-ready replay handler
  try {
    await loadWatchList(); // seed/last-good watch-list.json into Redis (survives pricedb outage)
  } catch (e) {
    logger.warn({ err: errMessage(e) }, '[watchlist] initial load failed; scheduler will retry');
  }
  startWatchListScheduler(); // refresh from pricedb.io now + every 24h
  bptfWs.start(); // connect to wss://ws.backpack.tf/events

  // Steam login → confirm Steam Guard → idle. Paper mode never sends offers, but
  // we still log in to read the shared inventory (under the steam lock).
  try {
    await startSteam();
  } catch (e) {
    logger.error({ err: errMessage(e) }, 'steam login failed; continuing without live inventory');
  }

  registerOfferHandler();
  startInventorySync();
  startListingRefresh();
  startListingReconcile(); // resolve real ids for async (queued) listings
  startScanner();

  // 6h balance summary to Telegram
  setInterval(() => void publishBalanceSummary(), 6 * 60 * 60 * 1000);

  logger.info('bptf-bot up');
}

// bot.js-style global guards: never let a stray rejection kill the process.
process.on('uncaughtException', (e) => logger.error({ err: errMessage(e) }, 'uncaughtException'));
process.on('unhandledRejection', (r) => logger.error({ err: errMessage(r) }, 'unhandledRejection'));

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  bptfWs.stop();
  stopWatchListScheduler();
  stopListingRefresh();
  stopListingReconcile();
  stopScanner();
  await disconnectRedis();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((e) => {
  logger.fatal({ err: errMessage(e) }, 'fatal boot error');
  process.exit(1);
});
