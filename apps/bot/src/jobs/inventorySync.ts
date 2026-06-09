import { withSteamLock } from '../coordination/steamLock.js';
import {
  loadInventory,
  countMetal,
  isSteamReady,
  type MetalCounts,
  type RawInvItem,
} from '../integrations/steam.js';
import { getAvailableBalance } from '../coordination/itemOwnership.js';
import { env } from '../config/index.js';
import { prisma } from '../integrations/db.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { redis } from '../integrations/redis.js';
import { publish, nowIso } from '../events/publisher.js';

// Shared key so the Telegram process (separate Node) can answer /balance without
// its own Steam session.
const BALANCE_KEY = 'bptf:lastBalance';
// BotConfig key holding a read-only live snapshot of the bot's Steam inventory
// (balance + non-currency items) for the panel. Read-only on purpose: on a shared
// account we never write the raw inventory into the InventoryItem positions ledger
// (that would mix in tf2vault-bot's items and corrupt position caps).
const INVENTORY_SNAPSHOT_KEY = 'steam:inventory';
const SNAPSHOT_ITEM_LIMIT = 250;

// Raw currency never appears in the panel's item list (it's shown as the balance).
const CURRENCY_NAMES = new Set([
  'Mann Co. Supply Crate Key',
  'Refined Metal',
  'Reclaimed Metal',
  'Scrap Metal',
]);

let lastBalance: ReturnType<typeof getAvailableBalance> | null = null;

export function getLastBalance() {
  return lastBalance;
}

/**
 * Persist a read-only snapshot of the live Steam inventory (balance + tradable
 * non-currency items) to BotConfig so the panel can show it. Self-guards: a
 * failure here never breaks the balance sync.
 */
async function writeInventorySnapshot(items: RawInvItem[], counts: MetalCounts): Promise<void> {
  const goods = items
    .filter((i) => {
      const name = i.market_hash_name || i.name || '';
      return name !== '' && !CURRENCY_NAMES.has(name) && i.tradable !== false;
    })
    .map((i) => ({ assetId: i.assetid, name: i.market_hash_name || i.name || 'Unknown' }));

  const snapshot = {
    at: nowIso(),
    balance: {
      keys: counts.keys,
      refined: counts.refined,
      reclaimed: counts.reclaimed,
      scrap: counts.scrap,
      refinedTotal: counts.refinedTotal,
    },
    itemCount: goods.length,
    items: goods.slice(0, SNAPSHOT_ITEM_LIMIT),
  };

  try {
    const value = JSON.stringify(snapshot);
    await prisma.botConfig.upsert({
      where: { key: INVENTORY_SNAPSHOT_KEY },
      create: { key: INVENTORY_SNAPSHOT_KEY, value },
      update: { value },
    });
  } catch (e) {
    logger.warn({ err: errMessage(e) }, 'inventory snapshot write failed');
  }
}

export async function syncBalanceOnce(): Promise<MetalCounts | null> {
  if (!isSteamReady()) {
    logger.debug('skip balance sync: steam not ready');
    return null;
  }
  try {
    // Load the inventory once under the lock, then derive both the balance and the
    // panel snapshot from it.
    const items = await withSteamLock('inventorySync', () => loadInventory());
    const counts = countMetal(items);
    lastBalance = getAvailableBalance(counts, env);
    await redis.set(BALANCE_KEY, JSON.stringify({ ...lastBalance, at: nowIso() }));
    await writeInventorySnapshot(items, counts);
    logger.info({ ...lastBalance, items: items.length }, 'balance synced');
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
