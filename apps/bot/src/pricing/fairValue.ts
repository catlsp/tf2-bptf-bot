import type { FairValue, MarketSnapshot } from '@bptf/types';
import { round2 } from '../lib/utils.js';
import { logger } from '../lib/logger.js';
import { getOrderBook } from '../orderbook/orderBook.js';

// Builds a single market view for one SKU from the real-time Redis order book
// (fed by the bp.tf WebSocket). No per-SKU bp.tf API calls happen here — that
// would blow the 60 req/min ceiling at watch-list scale. Fair value is the
// order-book midpoint; autoprice is reserved for the key→ref rate (refreshed once
// per scan in the scanner).

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

export async function getMarketSnapshot(sku: SkuRef): Promise<{ fair: FairValue; market: MarketSnapshot }> {
  const book = await getOrderBook(sku.skuKey);

  const lowestSell = book.sells[0]?.priceRef ?? null;
  const highestBuy = book.buys[0]?.priceRef ?? null;
  const fairValueRef = deriveFairValue(lowestSell, highestBuy);

  const fair: FairValue = {
    skuKey: sku.skuKey,
    fairValueRef,
    buyRef: highestBuy,
    sellRef: lowestSell,
    source: 'bptf-orderbook',
    capturedAt: new Date(),
  };

  const market: MarketSnapshot = {
    skuKey: sku.skuKey,
    fairValueRef,
    lowestSellRef: lowestSell,
    highestBuyRef: highestBuy,
    sellCount: book.sells.length,
    buyCount: book.buys.length,
  };

  if (market.sellCount > 0 || market.buyCount > 0) {
    logger.debug({ ...market }, `[ob] snapshot ${sku.skuKey}`);
  }

  return { fair, market };
}
