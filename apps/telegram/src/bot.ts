import { Bot } from 'grammy';
import pino from 'pino';
import { registerCommands, allowedChat } from './commands.js';
import { startNotifications } from './notifications.js';

// grammY entry. Talks only to TELEGRAM_CHAT_ID. Shares Redis + Neon with the bot
// process; it holds no Steam session of its own.

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } } : undefined,
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  logger.fatal('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
  process.exit(1);
}

const bot = new Bot(token);

// Hard gate: ignore any update not from the configured chat.
bot.use(async (ctx, next) => {
  if (ctx.chat && !allowedChat(ctx.chat.id)) {
    logger.warn({ chatId: ctx.chat.id }, 'ignoring update from unauthorized chat');
    return;
  }
  await next();
});

registerCommands(bot, logger);

bot.catch((err) => logger.error({ err: err.message }, 'grammY handler error'));

async function main(): Promise<void> {
  await startNotifications(bot, logger);
  await bot.api.sendMessage(chatId!, '🤖 bptf-bot telegram online (paper mode).').catch(() => {});
  logger.info('telegram bot starting');
  await bot.start();
}

process.on('uncaughtException', (e) => logger.error({ err: (e as Error).message }, 'uncaughtException'));
process.on('unhandledRejection', (r) => logger.error({ err: String(r) }, 'unhandledRejection'));

main().catch((e) => {
  logger.fatal({ err: (e as Error).message }, 'telegram fatal');
  process.exit(1);
});
