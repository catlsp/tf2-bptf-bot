import { withSteamLock } from '../coordination/steamLock.js';
import { safeLoadMetal, isSteamReady, type MetalCounts } from '../integrations/steam.js';
import { getAvailableBalance } from '../coordination/itemOwnership.js';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { redis } from '../integrations/redis.js';
import { publish, nowIso } from '../events/publisher.js';

// Shared key so the Telegram process (separate Node) can answer /balance without
// its own Steam session.
const BALANCE_KEY = 'bptf:lastBalance';

// Phase 1: read-only. Pull the shared inventory under the steam lock and cache a
// balance snapshot for /balance and the 6h summary. Phase 2 extends this to a
// full DB ↔ Steam reconcile of InventoryItem rows every 5 min.

let lastBalance: ReturnType<typeof getAvailableBalance> | null = null;

export function getLastBalance() {
  return lastBalance;
}

export async function syncBalanceOnce(): Promise<MetalCounts | null> {
  if (!isSteamReady()) {
    logger.debug('skip balance sync: steam not ready');
    return null;
  }
  try {
    const counts = await withSteamLock('inventorySync', () => safeLoadMetal());
    lastBalance = getAvailableBalance(counts, env);
    await redis.set(BALANCE_KEY, JSON.stringify({ ...lastBalance, at: nowIso() }));
    logger.info({ ...lastBalance }, 'balance synced');
    return counts;
  } catch (e) {
    logger.warn({ err: errMessage(e) }, 'balance sync failed');
    return null;
  }
}

export function startInventorySync(): void {
  void syncBalanceOnce();
  setInterval(() => void syncBalanceOnce(), 5 * 60 * 1000);
}

export async function publishBalanceSummary(): Promise<void> {
  await syncBalanceOnce();
  if (lastBalance) {
    await publish({ type: 'balance.summary', level: 'info', at: nowIso(), balance: lastBalance });
  }
}
