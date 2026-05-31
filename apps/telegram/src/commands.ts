import type { Bot, Context } from 'grammy';
import type { Logger } from 'pino';
import { Redis } from 'ioredis';
import { prisma } from '@bptf/db';

// Command handlers for /start, /balance, /stats, /stop, /resume. Keys here MUST
// match the bot process: bptf:emergencyStop and bptf:lastBalance.

const STOP_KEY = 'bptf:emergencyStop';
const BALANCE_KEY = 'bptf:lastBalance';

export const redis = new Redis({
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  db: Number(process.env.REDIS_DB ?? 0),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
});

const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
export function allowedChat(id: number | string): boolean {
  return String(id) === CHAT_ID;
}

async function balanceText(): Promise<string> {
  const raw = await redis.get(BALANCE_KEY);
  if (!raw) return 'No balance snapshot yet — the bot syncs every 5 min after Steam login.';
  const b = JSON.parse(raw) as {
    keys: number; refined: number; totalRef: number; reservedKeys: number; reservedRefined: number; at: string;
  };
  return [
    '💰 *Balance*',
    `Keys (available): ${b.keys}  _(reserved ${b.reservedKeys})_`,
    `Refined (available): ${b.refined.toFixed(2)}  _(reserved ${b.reservedRefined})_`,
    `Total: ~${b.totalRef.toFixed(2)} ref`,
    `_as of ${new Date(b.at).toLocaleString()}_`,
  ].join('\n');
}

async function statsText(): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [scans, paperBuys, paperSells, errors] = await Promise.all([
    prisma.eventLog.findMany({ where: { type: 'scan.completed', createdAt: { gte: since } }, select: { payload: true } }),
    prisma.eventLog.count({ where: { type: 'paper.buy', createdAt: { gte: since } } }),
    prisma.eventLog.count({ where: { type: 'paper.sell', createdAt: { gte: since } } }),
    prisma.eventLog.count({ where: { level: 'error', createdAt: { gte: since } } }),
  ]);
  const opportunities = scans.reduce((acc, s) => {
    const p = s.payload as { opportunities?: number } | null;
    return acc + (p?.opportunities ?? 0);
  }, 0);
  return [
    '📊 *Last 24h*',
    `Scans run: ${scans.length}`,
    `Opportunities found: ${opportunities}`,
    `Paper trades: ${paperBuys + paperSells}  _(buy ${paperBuys} / sell ${paperSells})_`,
    `Errors: ${errors}`,
  ].join('\n');
}

export function registerCommands(bot: Bot, logger: Logger): void {
  bot.command('start', async (ctx: Context) => {
    const stopped = (await redis.get(STOP_KEY)) === '1';
    await ctx.reply(
      ['👋 *bptf-bot* — paper trading.', `Emergency stop: ${stopped ? '🔴 ON' : '🟢 off'}`, '', 'Commands: /balance /stats /stop /resume'].join('\n'),
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('balance', async (ctx) => {
    await ctx.reply(await balanceText(), { parse_mode: 'Markdown' });
  });

  bot.command('stats', async (ctx) => {
    await ctx.reply(await statsText(), { parse_mode: 'Markdown' });
  });

  bot.command('stop', async (ctx) => {
    await redis.set(STOP_KEY, '1');
    logger.warn('emergency stop SET via telegram');
    await ctx.reply('🔴 Emergency stop *ON*. The bot will skip scans and trades.', { parse_mode: 'Markdown' });
  });

  bot.command('resume', async (ctx) => {
    await redis.set(STOP_KEY, '0');
    logger.warn('emergency stop CLEARED via telegram');
    await ctx.reply('🟢 Emergency stop *cleared*. Trading logic resumes.', { parse_mode: 'Markdown' });
  });
}
