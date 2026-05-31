import { randomUUID } from 'node:crypto';
import { redis } from '../integrations/redis.js';
import { logger } from '../lib/logger.js';
import { SteamLockError } from '../lib/errors.js';
import { sleep } from '../lib/utils.js';

// Distributed mutex over the SHARED Steam account. Both this bot and
// tf2vault-bot must take this lock before touching Steam, so the two never
// drive the same session concurrently. 30s TTL guards against a crashed holder;
// release is a Lua CAS so we only delete our own token.

const LOCK_KEY = 'shared:steam:lock';
const LOCK_TTL_SEC = 30;

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function withSteamLock<T>(
  op: string,
  fn: () => Promise<T>,
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const { retries = 5, retryDelayMs = 2000 } = opts;
  const value = randomUUID();

  for (let i = 0; i < retries; i++) {
    const ok = await redis.set(LOCK_KEY, value, 'EX', LOCK_TTL_SEC, 'NX');
    if (ok) {
      try {
        return await fn();
      } finally {
        await redis.eval(RELEASE_LUA, 1, LOCK_KEY, value);
      }
    }
    logger.warn({ op, attempt: i }, 'steam lock busy, retrying');
    await sleep(retryDelayMs);
  }
  throw new SteamLockError(op);
}
