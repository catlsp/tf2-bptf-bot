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

/**
 * pricedb.io reference rails. Hard bounds that no decision may cross: we never
 * pay more than {@link refBuyRef} on a buy, nor sell below {@link refSellRef}.
 * Either side may be null when pricedb has no price for that side.
 */
export interface RefBounds {
  refBuyRef?: number | null;
  refSellRef?: number | null;
}

export interface StrategyInput {
  skuKey: string;
  name: string;
  market: MarketSnapshot;
  /** pricedb reference rails. When omitted, no clamping is applied. */
  bounds?: RefBounds;
}

export function evaluate(input: StrategyInput): TradeDecision | null {
  const { market, name, skuKey } = input;
  const refBuyRef = input.bounds?.refBuyRef ?? null;
  const refSellRef = input.bounds?.refSellRef ?? null;
  const fv = market.fairValueRef;
  if (fv < MIN_VIABLE_REF) return null;

  // --- BUY side: is the lowest sell listing meaningfully under fair value? ---
  if (market.lowestSellRef != null) {
    const undervaluePct = round2(((fv - market.lowestSellRef) / fv) * 100);
    if (undervaluePct >= MIN_UNDERVALUE_PCT) {
      // We'd pay at or below our discounted target, capped at the listing price
      // and — the hard rail — never above the pricedb reference buy.
      let targetBuy = Math.min(market.lowestSellRef, applyDiscount(fv, env.BUY_DISCOUNT_PCT));
      if (refBuyRef != null) targetBuy = Math.min(targetBuy, refBuyRef);
      targetBuy = round2(targetBuy);
      const projectedSell = Math.max(fv, applyMarkup(targetBuy, env.SELL_MARKUP_PCT));
      const expectedProfitRef = round2(projectedSell - targetBuy);
      const marginPct = round2((expectedProfitRef / targetBuy) * 100);
      if (targetBuy > 0 && expectedProfitRef > 0) {
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
    // Hard rail: never sell below the pricedb reference sell.
    const minSell = Math.max(fv, applyMarkup(fv, env.SELL_MARKUP_PCT), refSellRef ?? 0);
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

// One scrap on the bp.tf grid (9 scrap = 1 refined). Used to undercut the sell
// floor by the minimum meaningful step.
const SCRAP_INCREMENT = 0.11;

/**
 * The three market figures the listing pricer needs. A narrower view than the
 * full {@link MarketSnapshot} so callers (and tests) only have to supply what
 * matters for pricing a BUY listing.
 */
export interface ListingMarket {
  fairValueRef: number;
  lowestSellRef: number | null;
  highestBuyRef: number | null;
}

export interface ListingPriceInput {
  skuKey: string;
  market: ListingMarket;
}

/**
 * Decide the buy-listing price for a SKU from its full market snapshot. Returns
 * null when listing would be unsafe or pointless:
 *   - fair value missing or below the dust threshold
 *   - no sell floor to anchor against (dead one-sided market)
 *   - computed buy would not beat the current best buy order (not competitive)
 *
 * Pricing rule:
 *   targetBuy = min(
 *     lowestSellRef - SCRAP_INCREMENT,        // never bid at/above the sell floor
 *     applyDiscount(fairValueRef, BUY_DISCOUNT_PCT)
 *   )
 * Then guard: targetBuy must be strictly above highestBuyRef, else we're not
 * competitive and shouldn't add another dead listing.
 *
 * This is the listing-side mirror of {@link evaluate}: same market-aware logic
 * (sell-floor undercut + competitive-vs-best-bid) the scanner already uses.
 */
export function evaluateListingBuyPrice(input: ListingPriceInput): number | null {
  const { market } = input;
  const fv = market.fairValueRef;
  if (fv < MIN_VIABLE_REF) return null;
  if (market.lowestSellRef == null) return null; // no sell-side market → don't list

  const discounted = applyDiscount(fv, env.BUY_DISCOUNT_PCT);
  const undercutSell = round2(market.lowestSellRef - SCRAP_INCREMENT);
  const targetBuy = Math.min(undercutSell, discounted);

  if (targetBuy <= 0) return null;
  if (market.highestBuyRef != null && targetBuy <= market.highestBuyRef) {
    // at or below the existing best bid — listing wouldn't be competitive
    return null;
  }
  return round2(targetBuy);
}

/**
 * Decide the sell-listing price for an item we own.
 *
 * Pricing rule:
 *   targetSell = max(applyMarkup(fv, SELL_MARKUP_PCT), highestBuyRef + 1 scrap)
 * then, if a sell floor exists, undercut it by one scrap — but never below the
 * markup floor (that would sell at a loss).
 *
 * Returns null when:
 *   - fair value is dust (< MIN_VIABLE_REF)
 *   - undercutting the floor would drop us below the markup floor (no margin)
 *   - the target wouldn't clear fair value (no profit)
 */
export function evaluateListingSellPrice(input: ListingPriceInput): number | null {
  const { market } = input;
  const fv = market.fairValueRef;
  if (fv < MIN_VIABLE_REF) return null;

  const markup = applyMarkup(fv, env.SELL_MARKUP_PCT);
  const aboveBid = market.highestBuyRef != null ? round2(market.highestBuyRef + SCRAP_INCREMENT) : 0;
  let targetSell = Math.max(markup, aboveBid);

  if (market.lowestSellRef != null) {
    const undercut = round2(market.lowestSellRef - SCRAP_INCREMENT);
    if (undercut < markup) return null; // can't undercut the floor without losing margin
    targetSell = Math.min(targetSell, undercut);
  }

  if (targetSell <= fv) return null; // no margin over fair value
  return round2(targetSell);
}

// ============================================================================
// Competitive market making (STRATEGY_MODE=market_making)
// Price off the pricedb per-SKU reference (the real market level where bots buy
// and sell), NOT the bp.tf WebSocket order book — that book is an incomplete
// live stream, so it produced uncompetitive bids (e.g. 23.55 ref while the
// market buys at 26.11). pricedb gives the true level; we bid there to actually
// win, and only when there's a flippable spread.
// ============================================================================

export interface CompetitiveBuyInput {
  /** pricedb BUY level in ref (where the market buys), already tightened by any per-SKU max-buy. */
  refBuyRef: number;
  /** pricedb SELL level in ref (where the market sells), already raised by any per-SKU min-sell. */
  refSellRef: number;
  /** Hard cap on what we'll pay for one item (ref). */
  maxBuyCapRef: number;
  /** Minimum flip spread to bother, in scrap (sell − buy must clear this). */
  minSpreadScrap: number;
}

/**
 * Competitive BUY price: bid at the pricedb buy level so we sit with the bots
 * that actually transact (not below a stale order book). Returns null when the
 * item is above our price cap, the price is dust, or the pricedb spread is too
 * thin to flip (sell − buy < minSpread) — no point buying what we can't resell up.
 */
export function priceCompetitiveBuy(i: CompetitiveBuyInput): number | null {
  if (i.refBuyRef < MIN_VIABLE_REF || i.refSellRef < MIN_VIABLE_REF) return null;
  if (i.refBuyRef > i.maxBuyCapRef) return null; // above the price cap → don't trade
  const spread = round2(i.refSellRef - i.refBuyRef);
  if (spread < i.minSpreadScrap * SCRAP_INCREMENT - 1e-9) return null; // no flippable margin
  return round2(i.refBuyRef);
}

/**
 * Competitive SELL price for an item we hold: list at the pricedb sell level, but
 * never below cost + minSpread (no selling at a loss). If the floor lands above
 * the market it just won't fill — safe, never a loss. Returns null on dust.
 */
export function priceCompetitiveSell(refSellRef: number, costBasis: number, minSpreadScrap: number): number | null {
  if (refSellRef < MIN_VIABLE_REF) return null;
  const floor = round2(costBasis + minSpreadScrap * SCRAP_INCREMENT);
  const sell = round2(Math.max(refSellRef, floor));
  if (sell <= costBasis) return null;
  return sell;
}
