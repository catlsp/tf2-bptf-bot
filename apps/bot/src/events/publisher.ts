import { BOT_EVENTS_CHANNEL, type BotEvent } from '@bptf/types';
import { redisPub } from '../integrations/redis.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';

// Single fan-out point for bot events. Telegram subscribes now; the dashboard
// WebSocket bridge will subscribe in Phase 9. Publishing must never throw into
// the caller — a dead subscriber can't be allowed to stall a scan.

export async function publish(event: BotEvent): Promise<void> {
  try {
    await redisPub.publish(BOT_EVENTS_CHANNEL, JSON.stringify(event));
  } catch (e) {
    logger.warn({ err: errMessage(e), type: event.type }, 'failed to publish bot event');
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
