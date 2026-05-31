import { z } from 'zod';
import { ConfigError } from '../lib/errors.js';

// Boot-time env validation. Anything missing/invalid fails fast and loud,
// the same spirit as bot.js throwing when a Steam key is absent.

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : v.toLowerCase() === 'true'));

const numFromStr = (def: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : Number(v)))
    .refine((n) => Number.isFinite(n), 'must be a number')
    .refine((n) => (min == null ? true : n >= min), `must be >= ${min}`)
    .refine((n) => (max == null ? true : n <= max), `must be <= ${max}`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  STEAM_ACCOUNT_NAME: z.string().min(1),
  STEAM_PASSWORD: z.string().min(1),
  STEAM_SHARED_SECRET: z.string().min(1),
  STEAM_IDENTITY_SECRET: z.string().min(1),

  BPTF_API_KEY: z.string().min(1),
  BPTF_USER_TOKEN: z.string().min(1),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: numFromStr(6379),
  REDIS_DB: numFromStr(0),
  REDIS_PASSWORD: z.string().optional(),

  TF2VAULT_RESERVE_KEYS: numFromStr(0, 0),
  TF2VAULT_RESERVE_REFINED: numFromStr(0, 0),

  PAPER_TRADING: boolish(true),
  EMERGENCY_STOP: boolish(false),

  BUY_DISCOUNT_PCT: numFromStr(20, 0, 90),
  SELL_MARKUP_PCT: numFromStr(12, 0, 200),
  MAX_HOLD_DAYS: numFromStr(7, 1),
  MAX_POSITION_PER_SKU: numFromStr(3, 1),
  MAX_DAILY_TRADES: numFromStr(30, 1),
  DAILY_LOSS_CUTOFF_PCT: numFromStr(10, 1, 100),

  STARTING_CAPITAL_REF: numFromStr(117, 0),
  KEY_TO_REF_FALLBACK: numFromStr(63, 1),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),

  SCANNER_INTERVAL_SEC: numFromStr(60, 10),
  WATCHLIST_SEED_SIZE: numFromStr(20, 1),

  BPTF_MAX_REQ_PER_MIN: numFromStr(60, 1, 60),

  // === Phase 2 — Maker (listings) controls ===
  PAPER_LISTINGS: boolish(true), // MUST stay true until flipped. Mirrors PAPER_TRADING semantics.
  LISTING_REFRESH_INTERVAL_SEC: numFromStr(1800, 10),
  MAX_LISTINGS: numFromStr(30, 1),
  LISTING_PRICE_DRIFT_PCT: numFromStr(2, 0),
  LISTING_DETAILS_TEMPLATE: z
    .string()
    .default('Bot offering {priceRef} ref. Send a trade offer with this exact item, the offer will be reviewed.'),
  BPTF_LISTING_DELAY_MS: numFromStr(1100, 0),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const env = loadEnv();
