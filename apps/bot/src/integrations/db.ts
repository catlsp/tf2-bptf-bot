import { prisma, checkDbConnection } from '@bptf/db';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';

export { prisma };

export async function connectDb(): Promise<void> {
  await checkDbConnection();
  logger.info('neon postgres connected');
}

/**
 * Append-only event log mirror of the pino logs, so the dashboard (Phase 9)
 * and /stats can query without scraping stdout. Fire-and-forget — a DB hiccup
 * must never take down the scanner (same defensive posture as bot.js).
 */
export async function logEvent(input: {
  type: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  payload?: unknown;
}): Promise<void> {
  try {
    await prisma.eventLog.create({
      data: {
        type: input.type,
        level: input.level,
        message: input.message,
        payload: (input.payload as object) ?? undefined,
      },
    });
  } catch (e) {
    logger.warn({ err: errMessage(e) }, 'failed to persist EventLog row');
  }
}
