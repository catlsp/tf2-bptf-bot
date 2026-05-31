import { redis } from '../integrations/redis.js';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { publish, nowIso } from '../events/publisher.js';

// Circuit breaker. The flag lives in Redis so Telegram /stop, the dashboard, and
// the trading loop all read/write the same source of truth. The env var
// EMERGENCY_STOP seeds the initial state at boot.

const STOP_KEY = 'bptf:emergencyStop';

export async function initEmergencyStop(): Promise<void> {
  const existing = await redis.get(STOP_KEY);
  if (existing == null) {
    await redis.set(STOP_KEY, env.EMERGENCY_STOP ? '1' : '0');
  }
}

export async function isStopped(): Promise<boolean> {
  return (await redis.get(STOP_KEY)) === '1';
}

export async function setStopped(active: boolean, reason: string): Promise<void> {
  await redis.set(STOP_KEY, active ? '1' : '0');
  logger.warn({ active, reason }, 'emergency stop changed');
  await publish({ type: 'emergency.stop', level: active ? 'error' : 'info', at: nowIso(), active, reason });
}
