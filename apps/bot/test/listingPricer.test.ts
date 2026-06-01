import { describe, it, expect, vi } from 'vitest';

// listingPricer.ts imports `env` (config) and `currentKeyRef` (bptf, which pulls
// in axios/pino and validates env at load) — mock both so the pure pricing
// helpers can be tested in isolation.
const h = vi.hoisted(() => ({
  env: { BUY_DISCOUNT_PCT: 8 } as Record<string, unknown>,
  currentKeyRef: vi.fn(() => 63),
}));
vi.mock('../src/config/index.js', () => ({ env: h.env, loadEnv: () => h.env }));
vi.mock('../src/integrations/bptf.js', () => ({ currentKeyRef: h.currentKeyRef }));

import { quantizeForDisplay } from '../src/pricing/listingPricer.js';

describe('quantizeForDisplay (mirrors bp.tf scrap-grid rendering)', () => {
  // bp.tf floors any sub-scrap remainder: 2.30 ref = 2 ref + 2.7 scrap → 2.22.
  it('2.30 → 2.22', () => expect(quantizeForDisplay(2.3)).toBe(2.22));

  // Values already exactly on the grid are unchanged.
  it('3.0  → 3.0', () => expect(quantizeForDisplay(3.0)).toBe(3.0));
  // NOTE: the spec sketch said 8.0 → 7.94, but 8.0 is an exact grid point
  // (0 sub-scrap remainder) so bp.tf renders it unchanged. The 7.94 figure was a
  // typo in the brief; the floor formula is what matches real bp.tf output.
  it('8.0  → 8.0', () => expect(quantizeForDisplay(8.0)).toBe(8.0));

  it('0    → 0', () => expect(quantizeForDisplay(0)).toBe(0));
  it('negative → 0', () => expect(quantizeForDisplay(-1)).toBe(0));

  // A sent metal of 2.75 (6.75 scrap) floors to 6 whole scrap → 2.66.
  it('2.75 → 2.66', () => expect(quantizeForDisplay(2.75)).toBe(2.66));
});
