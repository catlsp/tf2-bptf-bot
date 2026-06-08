import { describe, it, expect, vi } from 'vitest';

// orderBook imports redis + bptf (which pulls in config/env) + logger; mock them
// so the pure parseIntent helper can be imported without side effects.
vi.mock('../src/integrations/redis.js', () => ({ redis: { status: 'ready', on: vi.fn() } }));
vi.mock('../src/integrations/bptf.js', () => ({ currentKeyRef: () => 63 }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { parseIntent } from '../src/orderbook/orderBook.js';

describe('parseIntent (order-book accuracy)', () => {
  it('handles bp.tf v2 string intents', () => {
    expect(parseIntent('sell')).toBe('sell');
    expect(parseIntent('buy')).toBe('buy');
  });

  it('still handles legacy numeric intents', () => {
    expect(parseIntent(1)).toBe('sell');
    expect(parseIntent(0)).toBe('buy');
  });

  it('defaults unknown/missing to buy', () => {
    expect(parseIntent(undefined)).toBe('buy');
    expect(parseIntent('whatever')).toBe('buy');
  });

  it('regression: a string "sell" must NOT be filed as a buy (the original bug)', () => {
    // Old code was `intent === 1 ? 'sell' : 'buy'`, so a string 'sell' fell
    // through to 'buy' — corrupting the whole order book.
    expect(parseIntent('sell')).not.toBe('buy');
  });
});
