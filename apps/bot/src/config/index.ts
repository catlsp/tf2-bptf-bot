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

  BUY_DISCOUNT_PCT: numFromStr(8, 0, 90),
  SELL_MARKUP_PCT: numFromStr(12, 0, 200),
  // Smart autoprice: if the live sell floor is more than STALE_AUTOPRICE_PCT
  // below the autoprice buy, treat autoprice as stale and blend toward the live
  // floor with LIVE_MARKET_WEIGHT (1 = trust live floor fully).
  STALE_AUTOPRICE_PCT: numFromStr(10, 0, 50),
  LIVE_MARKET_WEIGHT: numFromStr(0.7, 0, 1),

  // === MVP simple market-making ===
  // 'market_making' = undercut sell floor / overbid buy floor by one scrap.
  // 'arbitrage'     = the smart-autoprice buy/sell evaluators (kept for later).
  STRATEGY_MODE: z.enum(['market_making', 'arbitrage']).default('market_making'),
  // Optional hard ceiling on what a BUY listing will bid (ref). Empty = no cap.
  MM_MAX_BUY_REF: z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? undefined : Number(v)))
    .refine((n) => n === undefined || Number.isFinite(n), 'must be a number'),
  // Minimum spread over cost basis a SELL must keep, in scrap (1 scrap = 0.11 ref).
  MM_MIN_SPREAD_SCRAP: numFromStr(1, 0),
  // How often to refresh the pricedb.io reference-price oracle (seconds). These
  // prices are the hard buy/sell rails every trade and listing is clamped to.
  PRICEDB_REFRESH_SEC: numFromStr(1800, 60),
  // 'manual' pins the watch-list to config/watch-list.json (no pricedb auto-refresh).
  // 'auto' builds it from pricedb's priced feed, filtered to affordable items.
  WATCHLIST_MODE: z.enum(['manual', 'auto']).default('manual'),
  // Auto mode only watches items whose pricedb BUY price is pure metal (no keys)
  // and at or below this many ref — keeps the list inside the junk-flip capital
  // band instead of tracking key-priced items the bot can't fund.
  WATCH_MAX_BUY_REF: numFromStr(50, 1),
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
  // {itemName} and {priceRef} are substituted per listing so the description
  // shows what we're buying and the price.
  LISTING_DETAILS_TEMPLATE: z
    .string()
    .default('Buying {itemName} for {priceRef} ref. Send a trade offer or add me.'),
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
