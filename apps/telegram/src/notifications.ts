import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import { Redis } from 'ioredis';
import { BOT_EVENTS_CHANNEL, type BotEvent } from '@bptf/types';

// Subscribes to the bot's Redis event channel and forwards a formatted message
// to the operator chat. Its own subscriber connection (ioredis requirement).

const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

function format(e: BotEvent): string | null {
  switch (e.type) {
    case 'paper.trade': {
      const d = e.decision;
      const icon = d.intent === 'BUY' ? '🟢' : '🔵';
      return [
        `${icon} *PAPER ${d.intent}* — ${d.name}`,
        `Price: ${d.priceRef} ref  (FV ${d.fairValueRef})`,
        `Est. profit: ${d.expectedProfitRef} ref (${d.marginPct}%)`,
        `_${d.reason}_`,
      ].join('\n');
    }
    case 'scan.completed':
      // keep the channel quiet unless something was found
      return e.opportunities > 0
        ? `🔎 Scan: ${e.opportunities} opportunit${e.opportunities === 1 ? 'y' : 'ies'} across ${e.skusScanned} SKUs (${e.durationMs}ms)`
        : null;
    case 'balance.summary':
      return `💰 6h balance: ${e.balance.keys} keys + ${e.balance.refined.toFixed(2)} ref (~${e.balance.totalRef.toFixed(2)} ref)`;
    case 'emergency.stop':
      return e.active ? `🔴 EMERGENCY STOP: ${e.reason}` : `🟢 Emergency stop cleared: ${e.reason}`;
    case 'error':
      return `⚠️ *${e.scope}* error: ${e.message}`;
    case 'listing.created': {
      const p = e.payload as { skuKey?: string; priceRef?: number };
      return `🏷️ Listing BUY ${p.skuKey} @ ${p.priceRef} ref`;
    }
    case 'listing.refresh.summary': {
      const p = e.payload as { created?: number; deleted?: number; skipped?: number; errors?: number; totalActive?: number };
      return `📋 Listings refresh: +${p.created} -${p.deleted} ~${p.skipped} err=${p.errors} active=${p.totalActive}`;
    }
    case 'listing.deleted':
      return null;
    default:
      return null;
  }
}

export async function startNotifications(bot: Bot, logger: Logger): Promise<void> {
  const sub = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    db: Number(process.env.REDIS_DB ?? 0),
    password: process.env.REDIS_PASSWORD || undefined,
  });

  await sub.subscribe(BOT_EVENTS_CHANNEL);
  sub.on('message', async (_channel, raw) => {
    try {
      const event = JSON.parse(raw) as BotEvent;
      const text = format(event);
      if (text) await bot.api.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'failed to forward bot event');
    }
  });
  logger.info('subscribed to bot events');
}
