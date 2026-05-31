import type { MarketSnapshot, TradeDecision } from '@bptf/types';
import { env } from '../config/index.js';
import { applyDiscount, applyMarkup, round2 } from '../lib/utils.js';

// Pure decision logic — no I/O. Given a market snapshot and our config, decide
// whether there's a buy or sell opportunity worth acting on.
//
//   buy  : there's a sell listing >= BUY_DISCOUNT_PCT below fair value, and our
//          target buy price still leaves margin after the intended markup.
//   sell : we could list at max(fair value, buyPrice * (1 + markup)) above the
//          current highest buy order (i.e. a real bid exists to hit).

const MIN_UNDERVALUE_PCT = 15; // candidate threshold from the spec
const MIN_VIABLE_REF = 0.05; // ignore dust below the cheapest hat band

export interface StrategyInput {
  skuKey: string;
  name: string;
  market: MarketSnapshot;
}

export function evaluate(input: StrategyInput): TradeDecision | null {
  const { market, name, skuKey } = input;
  const fv = market.fairValueRef;
  if (fv < MIN_VIABLE_REF) return null;

  // --- BUY side: is the lowest sell listing meaningfully under fair value? ---
  if (market.lowestSellRef != null) {
    const undervaluePct = round2(((fv - market.lowestSellRef) / fv) * 100);
    if (undervaluePct >= MIN_UNDERVALUE_PCT) {
      // We'd pay at or below our discounted target, capped at the listing price.
      const targetBuy = Math.min(market.lowestSellRef, applyDiscount(fv, env.BUY_DISCOUNT_PCT));
      const projectedSell = Math.max(fv, applyMarkup(targetBuy, env.SELL_MARKUP_PCT));
      const expectedProfitRef = round2(projectedSell - targetBuy);
      const marginPct = round2((expectedProfitRef / targetBuy) * 100);
      if (expectedProfitRef > 0) {
        return {
          skuKey,
          name,
          intent: 'BUY',
          priceRef: targetBuy,
          fairValueRef: fv,
          expectedProfitRef,
          marginPct,
          reason: `sell listing ${undervaluePct}% below FV; buy ${targetBuy} → sell ~${projectedSell}`,
          partnerSteamId: null,
        };
      }
    }
  }

  // --- SELL side: is there a buy order high enough to satisfy our markup? ---
  if (market.highestBuyRef != null) {
    const minSell = Math.max(fv, applyMarkup(fv, env.SELL_MARKUP_PCT));
    if (market.highestBuyRef >= minSell) {
      const expectedProfitRef = round2(market.highestBuyRef - fv);
      return {
        skuKey,
        name,
        intent: 'SELL',
        priceRef: market.highestBuyRef,
        fairValueRef: fv,
        expectedProfitRef,
        marginPct: round2((expectedProfitRef / fv) * 100),
        reason: `buy order ${market.highestBuyRef} >= min sell ${round2(minSell)}`,
        partnerSteamId: null,
      };
    }
  }

  return null;
}
