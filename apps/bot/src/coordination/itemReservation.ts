import { redis } from '../integrations/redis.js';

// Prevents double-spend of the same assetId across both bots. Before either bot
// puts an item into an offer it SADDs the assetId here; the other bot checks
// membership first. Shared key name is part of the integration contract — do not
// rename without updating tf2vault-integration.md.

const RESERVED_SET = 'shared:steam:reservedItems';

export async function reserveItems(assetIds: string[]): Promise<boolean> {
  if (assetIds.length === 0) return true;
  const added = await redis.sadd(RESERVED_SET, ...assetIds);
  return added === assetIds.length;
}

export async function releaseItems(assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;
  await redis.srem(RESERVED_SET, ...assetIds);
}

export async function isReserved(assetId: string): Promise<boolean> {
  return (await redis.sismember(RESERVED_SET, assetId)) === 1;
}
