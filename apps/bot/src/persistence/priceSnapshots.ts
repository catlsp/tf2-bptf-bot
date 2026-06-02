import type { FairValue } from '@bptf/types';
import type { SkuRef } from '../pricing/fairValue.js';
import { prisma, logEvent } from '../integrations/db.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { getOrCreateItemId } from './items.js';

// PriceSnapshot persistence for the scanner. Each successful scan of a SKU with
// live market data records a snapshot, building the time series the dashboard's
// price chart reads.
//
// Volume guard: ~20+ SKUs × every scan tick would be tens of thousands of rows a
// day, mostly identical, which would bloat the free-tier Neon. We skip a snapshot
// when its (buyRef, sellRef) is unchanged from the previous one for that SKU — the
// chart connects points, so dropping consecutive duplicates preserves the curve.
// The first snapshot per SKU after boot always writes.
const lastFingerprintBySku = new Map<string, string>();

/**
 * Persist a price snapshot for a scanned SKU. Defensive: a DB hiccup is logged to
 * EventLog (`db.writeError`) and swallowed so it can never stall the scan loop.
 */
export async function recordPriceSnapshot(sku: SkuRef, fair: FairValue): Promise<void> {
  // No order-book data on either side — nothing worth recording.
  if (fair.buyRef == null && fair.sellRef == null) return;

  const fingerprint = `${fair.buyRef ?? ''}|${fair.sellRef ?? ''}`;
  if (lastFingerprintBySku.get(sku.skuKey) === fingerprint) return;

  try {
    const itemId = await getOrCreateItemId(sku.skuKey, sku.name);
    await prisma.priceSnapshot.create({
      data: {
        itemId,
        buyRef: fair.buyRef,
        sellRef: fair.sellRef,
        source: fair.source,
        capturedAt: fair.capturedAt,
      },
    });
    lastFingerprintBySku.set(sku.skuKey, fingerprint);
  } catch (e) {
    logger.warn({ err: errMessage(e), sku: sku.skuKey }, 'failed to persist price snapshot');
    await logEvent({
      type: 'db.writeError',
      level: 'error',
      message: errMessage(e),
      payload: { op: 'priceSnapshot.create', sku: sku.skuKey },
    });
  }
}
