import type { Balance } from '@bptf/types';
import type { Env } from '../config/index.js';
import type { MetalCounts } from '../integrations/steam.js';
import { DEFINDEX } from '../lib/utils.js';
import { currentKeyRef } from '../integrations/bptf.js';

// Decides which slice of the shared inventory THIS bot may touch. tf2vault-bot
// owns pure-currency flows (keys + raw metal for its key/ticket exchange), so we
// never list or trade those defindexes, and we subtract its reserve from the
// balance we consider spendable.

export const TF2VAULT_OWNED_DEFINDEXES = new Set<number>([
  DEFINDEX.KEY, // 5021
  DEFINDEX.REFINED, // 5002
  DEFINDEX.RECLAIMED, // 5001
  DEFINDEX.SCRAP, // 5000
]);

/** Cosmetics/weapons/kits are fair game; raw currency belongs to tf2vault-bot. */
export function isItemTradableByBptfBot(item: { defindex: number }): boolean {
  return !TF2VAULT_OWNED_DEFINDEXES.has(item.defindex);
}

/**
 * Spendable balance = on-hand minus tf2vault reserves. Reserves default to 0
 * during dev and get raised via env before the thesis defense.
 */
export function getAvailableBalance(inv: MetalCounts, env: Env): Balance {
  const reserveKeys = env.TF2VAULT_RESERVE_KEYS;
  const reserveRef = env.TF2VAULT_RESERVE_REFINED;
  const keys = Math.max(0, inv.keys - reserveKeys);
  const refined = Math.max(0, inv.refinedTotal - reserveRef);
  return {
    keys,
    refined,
    totalRef: keys * currentKeyRef() + refined,
    reservedKeys: reserveKeys,
    reservedRefined: reserveRef,
  };
}
