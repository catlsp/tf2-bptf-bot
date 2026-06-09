import type { FairValue, MarketSnapshot } from '@bptf/types';
import { round2 } from '../lib/utils.js';
import { logger } from '../lib/logger.js';
import { getOrderBook } from '../orderbook/orderBook.js';
import { getRefPrice } from './priceOracle.js';

// Builds a single market view for one SKU. The pricedb.io oracle is the
// authoritative price (buy/sell rails + fair value); the real-time Redis order
// book (fed by the bp.tf WebSocket) supplies live liquidity context. When pricedb
// has no price we fall back to the order-book midpoint, but the caller is
// expected to skip trading such SKUs (hard-rails policy) — `hasRef` says which.

export interface SkuRef {
  skuKey: string;
  name: string;
  quality: number;
  craftable: boolean;
}

/** Mid-point fair value from the live order book. */
function deriveFairValue(lowestSell: number | null, highestBuy: number | null): number {
  if (lowestSell != null && highestBuy != null) return round2((lowestSell + highestBuy) / 2);
  if (lowestSell != null) return lowestSell;
  if (highestBuy != null) return highestBuy;
  return 0;
}

export async function getMarketSnapshot(
  sku: SkuRef,
): Promise<{ fair: FairValue; market: MarketSnapshot; hasRef: boolean }> {
  const book = await getOrderBook(sku.skuKey);
  const obLowestSell = book.sells[0]?.priceRef ?? null;
  const obHighestBuy = book.buys[0]?.priceRef ?? null;

  // pricedb anchors fair value and is what the panel displays (the "adequate"
  // reference price). The strategy, however, still sees the live order book on
  // both sides so it can spot a genuinely under-priced listing — pricedb is then
  // applied as a hard rail downstream, not as the signal itself. Fall back to the
  // order-book midpoint only when pricedb has no price for the SKU.
  const ref = getRefPrice(sku.skuKey);
  const fairValueRef = ref ? round2((ref.buyRef + ref.sellRef) / 2) : deriveFairValue(obLowestSell, obHighestBuy);

  // Display side: pricedb buy/sell when available, else the live book.
  const fair: FairValue = {
    skuKey: sku.skuKey,
    fairValueRef,
    buyRef: ref ? ref.buyRef : obHighestBuy,
    sellRef: ref ? ref.sellRef : obLowestSell,
    source: ref ? 'pricedb' : 'bptf-orderbook',
    capturedAt: new Date(),
  };

  // Strategy side: live order book is the opportunity signal; fair value is the
  // pricedb-anchored midpoint.
  const market: MarketSnapshot = {
    skuKey: sku.skuKey,
    fairValueRef,
    lowestSellRef: obLowestSell,
    highestBuyRef: obHighestBuy,
    sellCount: book.sells.length,
    buyCount: book.buys.length,
  };

  if (market.sellCount > 0 || market.buyCount > 0 || ref) {
    logger.debug({ ...market, source: fair.source }, `[snapshot] ${sku.skuKey}`);
  }

  return { fair, market, hasRef: ref != null };
}
