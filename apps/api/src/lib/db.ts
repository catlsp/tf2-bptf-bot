import { prisma as basePrisma, checkDbConnection, Prisma } from '@bptf/db';

// The API is request-driven and goes idle between clicks, so Neon (serverless,
// free tier) reaps the pooled TCP connections. The next query then grabs a dead
// connection and fails with P1017 "Server has closed the connection" — the bot
// never sees this because its 60s scanner keeps the pool warm. We wrap every
// operation in a small retry: when a connection-level error hits, Prisma evicts
// the dead connection and the next attempt gets a fresh one. All API operations
// are reads or single-row idempotent writes, and a P1017/P2024 means the query
// never committed, so retrying is safe.

const TRANSIENT_CODES = new Set([
  'P1017', // server has closed the connection
  'P1001', // can't reach database server
  'P2024', // timed out fetching a connection from the pool
]);

const TRANSIENT_MESSAGE = /server has closed the connection|connection reset|ECONNRESET|timed out fetching/i;

function isTransient(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return TRANSIENT_CODES.has(error.code);
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  const message = error instanceof Error ? error.message : '';
  return TRANSIENT_MESSAGE.test(message);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Neon's free tier autosuspends after a few idle minutes; waking it can take
// 20-30s. The retry window (attempts × backoff, on top of each failed attempt's
// connect timeout) is sized to bridge that wake so the user's first request
// after a long idle returns data — slowly — instead of erroring.
const MAX_ATTEMPTS = 5;

export const prisma = basePrisma.$extends({
  name: 'retry-transient-connection',
  query: {
    async $allOperations({ args, query }) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await query(args);
        } catch (error) {
          lastError = error;
          if (!isTransient(error) || attempt === MAX_ATTEMPTS) throw error;
          await sleep(Math.min(attempt * 500, 3000));
        }
      }
      throw lastError;
    },
  },
});

export async function checkDb(): Promise<void> {
  await checkDbConnection();
}
