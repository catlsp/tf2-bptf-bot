import { z } from 'zod';

// Zod schemas describing the API's response contract. They mirror
// packages/db/prisma/schema.prisma (the source of truth for the data shape)
// and are reused both for Fastify response serialization and the WebSocket
// payloads so there's a single place the wire format is defined.
//
// Decimal columns on OurListing are exposed as plain numbers (see
// serializers.ts); every other model uses Float/Int already.

export const itemSchema = z.object({
  id: z.string(),
  defindex: z.number().int(),
  quality: z.number().int(),
  craftable: z.boolean(),
  killstreak: z.number().int(),
  australium: z.boolean(),
  effect: z.number().int().nullable(),
  skuKey: z.string(),
  name: z.string(),
  createdAt: z.date(),
});

export const ourListingSchema = z.object({
  id: z.string(),
  bptfListingId: z.string().nullable(),
  skuKey: z.string(),
  intent: z.string(),
  priceRef: z.number(),
  priceKeys: z.number().int(),
  priceMetal: z.number(),
  fairValueRef: z.number(),
  details: z.string().nullable(),
  status: z.string(),
  errorMessage: z.string().nullable(),
  createdAt: z.date(),
  refreshedAt: z.date(),
  deletedAt: z.date().nullable(),
});

export const inventoryStatusSchema = z.enum(['HELD', 'LISTED', 'RESERVED', 'SOLD']);

export const inventoryItemSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  itemId: z.string(),
  acquiredAt: z.date(),
  acquiredPriceRef: z.number(),
  status: inventoryStatusSchema,
  reservedFor: z.string().nullable(),
  item: itemSchema,
});

export const listingIntentSchema = z.enum(['BUY', 'SELL']);

export const tradeStatusSchema = z.enum([
  'PENDING',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELED',
  'FAILED',
]);

export const tradeSchema = z.object({
  id: z.string(),
  steamOfferId: z.string(),
  partnerSteamId: z.string(),
  itemId: z.string(),
  intent: listingIntentSchema,
  priceRef: z.number(),
  fairValueRef: z.number(),
  profitRef: z.number().nullable(),
  status: tradeStatusSchema,
  createdAt: z.date(),
  completedAt: z.date().nullable(),
  errorMessage: z.string().nullable(),
  item: itemSchema,
});

export const watchlistEntrySchema = z.object({
  id: z.string(),
  skuKey: z.string(),
  maxBuyRef: z.number(),
  minSellRef: z.number().nullable(),
  active: z.boolean(),
  priority: z.number().int(),
  notes: z.string().nullable(),
});

export const eventLogLevelSchema = z.enum(['info', 'warn', 'error']);

export const eventLogSchema = z.object({
  id: z.string(),
  type: z.string(),
  level: z.string(),
  message: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.date(),
});

export const priceSnapshotSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  buyRef: z.number().nullable(),
  sellRef: z.number().nullable(),
  source: z.string(),
  capturedAt: z.date(),
});

export const errorResponseSchema = z.object({
  error: z.string(),
});
