import Redis from 'ioredis';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';

// Local redis on VPS #2, shared with tf2vault-bot for coordination + pub/sub.
// One connection for commands; pub/sub gets its own (ioredis requirement).

function build(): Redis {
  return new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    db: env.REDIS_DB,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
}

export const redis = build();
export const redisSub = build();
export const redisPub = build();

export async function connectRedis(): Promise<void> {
  await Promise.all([redis.connect(), redisSub.connect(), redisPub.connect()]);
  const pong = await redis.ping();
  if (pong !== 'PONG') throw new Error(`redis ping returned ${pong}`);
  logger.info({ host: env.REDIS_HOST, port: env.REDIS_PORT, db: env.REDIS_DB }, 'redis connected');
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSub.quit(), redisPub.quit()]);
}
