import { z } from 'zod';

// Boot-time env validation, mirroring apps/bot/src/config/index.ts. Anything
// missing/invalid fails fast and loud so the process never starts half-configured.

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

  PORT: numFromStr(3001, 1, 65535),
  HOST: z.string().default('127.0.0.1'),

  DATABASE_URL: z.string().url(),

  // Comma-separated list of allowed browser origins.
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const env = loadEnv();
