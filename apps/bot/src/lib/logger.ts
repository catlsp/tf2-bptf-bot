import { pino, destination } from 'pino';

// JSON in prod (cheap, parseable on the VPS), pretty in dev.
const isDev = process.env.NODE_ENV !== 'production';

const opts = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'bptf-bot' },
};

// Dev: pretty transport. Prod: synchronous destination to fd 1 so logs flush
// immediately — pino's default async buffering held back low-volume info logs
// under pm2, making live trades hard to watch.
export const logger = isDev
  ? pino({
      ...opts,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,app' },
      },
    })
  : pino(opts, destination({ sync: true }));

export type Logger = typeof logger;
