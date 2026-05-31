import pino from 'pino';

// JSON in prod (cheap, parseable on the VPS), pretty in dev.
const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'bptf-bot' },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,app' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
