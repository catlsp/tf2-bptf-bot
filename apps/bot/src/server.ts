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
import { startListingRefresh } from './jobs/listingRefresh.js';

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
