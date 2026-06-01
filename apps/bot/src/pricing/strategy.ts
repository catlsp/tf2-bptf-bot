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
// MVP simple market making (STRATEGY_MODE=market_making)
// Pure functions over an order-book view. No fair value, no autoprice — just
// sit one scrap inside the spread. buys[0] = highest bid, sells[0] = lowest ask
// (see orderbook/orderBook.ts getOrderBook ordering).
// ============================================================================

export interface OrderBookView {
  buys: Array<{ priceRef: number }>;
  sells: Array<{ priceRef: number }>;
}

/**
 * BUY price = highest existing bid + 1 scrap (so we sit just above the book),
 * capped by env.MM_MAX_BUY_REF when set. Returns null when there are no bids to
 * beat (nothing to anchor against).
 */
export function evaluateMarketMakingBuy(orderbook: OrderBookView): number | null {
  const highest = orderbook.buys[0]?.priceRef;
  if (highest == null) return null;
  let price = round2(highest + SCRAP_INCREMENT);
  if (env.MM_MAX_BUY_REF != null && price > env.MM_MAX_BUY_REF) {
    price = round2(env.MM_MAX_BUY_REF);
  }
  if (price <= 0) return null;
  return price;
}

/**
 * SELL price = lowest existing ask − 1 scrap (undercut the floor), but never
 * below costBasis + MM_MIN_SPREAD_SCRAP scrap. Returns null when there are no
 * asks to undercut, or undercutting would dip below the minimum spread (selling
 * at a loss / no edge).
 */
export function evaluateMarketMakingSell(orderbook: OrderBookView, costBasis: number): number | null {
  const lowest = orderbook.sells[0]?.priceRef;
  if (lowest == null) return null;
  const undercut = round2(lowest - SCRAP_INCREMENT);
  const floor = round2(costBasis + env.MM_MIN_SPREAD_SCRAP * SCRAP_INCREMENT);
  if (undercut < floor) return null;
  return undercut;
}
