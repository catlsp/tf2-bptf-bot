import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Prisma } from '@bptf/db';
import { z } from 'zod';
import { prisma } from '../lib/db.js';

// The bot records a PriceSnapshot per scan per tracked SKU. This endpoint returns
// the LATEST snapshot per item (top buy + top sell from the live order book) so
// the panel can show the current market for everything the bot watches — the
// items the bot actually tracks, not the (separate) WatchlistEntry table.

const marketItemSchema = z.object({
  itemId: z.string(),
  skuKey: z.string(),
  name: z.string(),
  buyRef: z.number().nullable(),
  sellRef: z.number().nullable(),
  spreadRef: z.number().nullable(),
  source: z.string(),
  capturedAt: z.date(),
});

const marketResponseSchema = z.array(marketItemSchema);

interface LatestRow {
  itemId: string;
  skuKey: string;
  name: string;
  buyRef: number | null;
  sellRef: number | null;
  source: string;
  capturedAt: Date;
}

export const marketRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/market', { schema: { response: { 200: marketResponseSchema } } }, async () => {
    // DISTINCT ON gives one row per item — the most recent snapshot.
    const rows = await prisma.$queryRaw<LatestRow[]>(Prisma.sql`
      SELECT DISTINCT ON (ps."itemId")
        ps."itemId"     AS "itemId",
        i."skuKey"      AS "skuKey",
        i."name"        AS "name",
        ps."buyRef"     AS "buyRef",
        ps."sellRef"    AS "sellRef",
        ps."source"     AS "source",
        ps."capturedAt" AS "capturedAt"
      FROM "PriceSnapshot" ps
      JOIN "Item" i ON i.id = ps."itemId"
      ORDER BY ps."itemId", ps."capturedAt" DESC
    `);

    return rows.map((r) => ({
      itemId: r.itemId,
      skuKey: r.skuKey,
      name: r.name,
      buyRef: r.buyRef,
      sellRef: r.sellRef,
      spreadRef:
        r.buyRef != null && r.sellRef != null ? Number((r.sellRef - r.buyRef).toFixed(2)) : null,
      source: r.source,
      capturedAt: r.capturedAt,
    }));
  });
};
