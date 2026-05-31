import type { FairValue, MarketSnapshot } from '@bptf/types';
import { fetchAutoprice, fetchListings } from '../integrations/bptf.js';
import { defindexFromSkuKey, round2 } from '../lib/utils.js';
import { logEvent } from '../integrations/db.js';

// Builds a single market view for one SKU: pull bp.tf autoprice + live
// classifieds, then derive fairValueRef, lowest sell, and highest buy.

export interface SkuRef {
  skuKey: string;
  name: string;
  quality: number;
  craftable: boolean;
}

/** Mid-point fair value, preferring autoprice but sanity-checked against the book. */
function deriveFairValue(
  autoBuy: number | null,
  autoSell: number | null,
  lowestSell: number | null,
  highestBuy: number | null,
): number {
  if (autoBuy != null && autoSell != null) return round2((autoBuy + autoSell) / 2);
  if (lowestSell != null && highestBuy != null) return round2((lowestSell + highestBuy) / 2);
  if (autoSell != null) return autoSell;
  if (lowestSell != null) return lowestSell;
  if (highestBuy != null) return highestBuy;
  return 0;
}

export async function getMarketSnapshot(sku: SkuRef): Promise<{ fair: FairValue; market: MarketSnapshot }> {
  const defindex = defindexFromSkuKey(sku.skuKey);
  const [auto, book] = await Promise.all([
    fetchAutoprice({ skuKey: sku.skuKey, name: sku.name, quality: sku.quality }),
    fetchListings({ skuKey: sku.skuKey, defindex, quality: sku.quality, craftable: sku.craftable }),
  ]);

  const lowestSell = book.sell[0]?.priceRef ?? null;
  const highestBuy = book.buy[0]?.priceRef ?? null;
  const fairValueRef = deriveFairValue(auto.buyRef, auto.sellRef, lowestSell, highestBuy);

  const fair: FairValue = {
    skuKey: sku.skuKey,
    fairValueRef,
    buyRef: auto.buyRef,
    sellRef: auto.sellRef,
    source: 'bptf-autoprice',
    capturedAt: new Date(),
  };

  const market: MarketSnapshot = {
    skuKey: sku.skuKey,
    fairValueRef,
    lowestSellRef: lowestSell,
    highestBuyRef: highestBuy,
    sellCount: book.sell.length,
    buyCount: book.buy.length,
  };

  await logEvent({
    type: 'pricing.snapshot',
    level: 'info',
    message: `fair value for ${sku.name}`,
    payload: { ...market, autoBuy: auto.buyRef, autoSell: auto.sellRef },
  });

  return { fair, market };
}
