import type { OurListing } from '@bptf/db';
import type { z } from 'zod';
import type { ourListingSchema } from './schemas.js';

export type SerializedOurListing = z.infer<typeof ourListingSchema>;

/**
 * OurListing stores priceRef/priceMetal/fairValueRef as Prisma.Decimal. The API
 * exposes them as plain numbers so the JSON contract is `number`, not a Decimal
 * object stringified inconsistently across the wire.
 */
export function serializeOurListing(row: OurListing): SerializedOurListing {
  return {
    id: row.id,
    bptfListingId: row.bptfListingId,
    skuKey: row.skuKey,
    intent: row.intent,
    priceRef: row.priceRef.toNumber(),
    priceKeys: row.priceKeys,
    priceMetal: row.priceMetal.toNumber(),
    fairValueRef: row.fairValueRef.toNumber(),
    details: row.details,
    status: row.status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    refreshedAt: row.refreshedAt,
    deletedAt: row.deletedAt,
  };
}
