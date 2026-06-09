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

describe('quantizeForDisplay (snaps to bp.tf scrap grid, with carry)', () => {
  // The bug this fixes: a pricedb grid value like 1.88 (1 ref + 8 scrap) must
  // round-trip to 1.88, not collapse to 1.77 — round(1.88×9)=17 scrap → 1.88.
  it('1.88 → 1.88 (8 scrap, recovered not floored)', () => expect(quantizeForDisplay(1.88)).toBe(1.88));

  // 2.30 ref → round(20.7)=21 scrap → 2 ref + 3 scrap → 2.33 (nearest grid point).
  it('2.30 → 2.33', () => expect(quantizeForDisplay(2.3)).toBe(2.33));

  // Values already on the grid are unchanged; 9th scrap carries into a refined.
  it('3.0  → 3.0', () => expect(quantizeForDisplay(3.0)).toBe(3.0));
  it('8.0  → 8.0', () => expect(quantizeForDisplay(8.0)).toBe(8.0));
  it('1.0  → 1.0 (9 scrap carries to 1 ref)', () => expect(quantizeForDisplay(1.0)).toBe(1.0));

  it('0    → 0', () => expect(quantizeForDisplay(0)).toBe(0));
  it('negative → 0', () => expect(quantizeForDisplay(-1)).toBe(0));

  // 2.75 ref → round(24.75)=25 scrap → 2 ref + 7 scrap → 2.77.
  it('2.75 → 2.77', () => expect(quantizeForDisplay(2.75)).toBe(2.77));
});
