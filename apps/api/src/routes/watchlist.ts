import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Prisma } from '@bptf/db';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { watchlistEntrySchema, watchlistRowSchema, errorResponseSchema } from '../lib/schemas.js';

// The Watchlist page is the per-SKU control panel for the live bot. It shows the
// SKUs the bot actually tracks (latest pricedb price + how many we hold) merged
// with each one's optional WatchlistEntry override (pause, max buy, min sell,
// max qty). A SKU with no override runs on defaults. Edits upsert by skuKey, so
// the page can attach an override to a tracked SKU that has none yet.

const HELD_STATUSES = ['HELD', 'LISTED', 'RESERVED'] as const;

const upsertBodySchema = z.object({
  skuKey: z.string().min(1),
  maxBuyRef: z.number().positive().optional(),
  minSellRef: z.number().positive().nullable().optional(),
  maxQty: z.number().int().positive().nullable().optional(),
  active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

const entryParamsSchema = z.object({ id: z.string().min(1) });

const watchlistRowsResponseSchema = z.array(watchlistRowSchema);

interface LatestRow {
  itemId: string;
  skuKey: string;
  name: string;
  buyRef: number | null;
  sellRef: number | null;
  source: string;
}

export const watchlistRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/watchlist', { schema: { response: { 200: watchlistRowsResponseSchema } } }, async () => {
    // 1. Latest price snapshot per tracked item (name + pricedb buy/sell).
    const snapshots = await prisma.$queryRaw<LatestRow[]>(Prisma.sql`
      SELECT DISTINCT ON (ps."itemId")
        ps."itemId"  AS "itemId",
        i."skuKey"   AS "skuKey",
        i."name"     AS "name",
        ps."buyRef"  AS "buyRef",
        ps."sellRef" AS "sellRef",
        ps."source"  AS "source"
      FROM "PriceSnapshot" ps
      JOIN "Item" i ON i.id = ps."itemId"
      ORDER BY ps."itemId", ps."capturedAt" DESC
    `);

    // 2. Per-SKU overrides.
    const entries = await prisma.watchlistEntry.findMany();
    const entryBySku = new Map(entries.map((e) => [e.skuKey, e]));

    // 3. How many of each SKU we currently hold/list/reserve.
    const grouped = await prisma.inventoryItem.groupBy({
      by: ['itemId'],
      where: { status: { in: [...HELD_STATUSES] } },
      _count: { _all: true },
    });
    const heldItemIds = grouped.map((g) => g.itemId);
    const heldItems = heldItemIds.length
      ? await prisma.item.findMany({ where: { id: { in: heldItemIds } }, select: { id: true, skuKey: true } })
      : [];
    const skuByItemId = new Map(heldItems.map((i) => [i.id, i.skuKey]));
    const heldBySku = new Map<string, number>();
    for (const g of grouped) {
      const sku = skuByItemId.get(g.itemId);
      if (sku) heldBySku.set(sku, g._count._all);
    }

    // 4. Merge: every tracked SKU, plus override SKUs — but skip legacy seed rows
    // (a default WatchlistEntry that isn't tracked and carries no real override),
    // so the panel isn't cluttered with priceless "13;11"-style placeholders.
    const snapshotBySku = new Map(snapshots.map((s) => [s.skuKey, s]));
    const isMeaningfulOverride = (e: (typeof entries)[number]): boolean =>
      e.active === false ||
      e.maxQty != null ||
      e.minSellRef != null ||
      (e.maxBuyRef != null && e.maxBuyRef < 9000) ||
      (e.notes != null && e.notes !== '');
    const allSkus = new Set<string>(snapshotBySku.keys());
    for (const e of entries) {
      if (snapshotBySku.has(e.skuKey) || isMeaningfulOverride(e)) allSkus.add(e.skuKey);
    }

    const rows = [...allSkus].map((skuKey) => {
      const snap = snapshotBySku.get(skuKey) ?? null;
      const entry = entryBySku.get(skuKey) ?? null;
      return {
        skuKey,
        name: snap?.name ?? null,
        refBuyRef: snap?.buyRef ?? null,
        refSellRef: snap?.sellRef ?? null,
        source: snap?.source ?? null,
        held: heldBySku.get(skuKey) ?? 0,
        entryId: entry?.id ?? null,
        active: entry ? entry.active : true,
        maxBuyRef: entry?.maxBuyRef ?? null,
        minSellRef: entry?.minSellRef ?? null,
        maxQty: entry?.maxQty ?? null,
        notes: entry?.notes ?? null,
      };
    });

    // Paused first (need attention), then by name, then SKU.
    rows.sort((a, b) => {
      if (a.active !== b.active) return a.active ? 1 : -1;
      return (a.name ?? a.skuKey).localeCompare(b.name ?? b.skuKey);
    });
    return rows;
  });

  // Upsert a per-SKU override by skuKey (create on first edit, patch thereafter).
  app.put(
    '/watchlist',
    { schema: { body: upsertBodySchema, response: { 200: watchlistEntrySchema } } },
    async (request) => {
      const { skuKey, maxBuyRef, minSellRef, maxQty, active, notes } = request.body;
      const update: Prisma.WatchlistEntryUpdateInput = {};
      if (maxBuyRef !== undefined) update.maxBuyRef = maxBuyRef;
      if (minSellRef !== undefined) update.minSellRef = minSellRef;
      if (maxQty !== undefined) update.maxQty = maxQty;
      if (active !== undefined) update.active = active;
      if (notes !== undefined) update.notes = notes;
      return prisma.watchlistEntry.upsert({
        where: { skuKey },
        create: {
          skuKey,
          maxBuyRef: maxBuyRef ?? 9999,
          minSellRef: minSellRef ?? null,
          maxQty: maxQty ?? null,
          active: active ?? true,
          notes: notes ?? null,
        },
        update,
      });
    },
  );

  // Remove an override (the SKU reverts to defaults). Keyed by entry id.
  app.delete(
    '/watchlist/:id',
    { schema: { params: entryParamsSchema, response: { 204: z.null(), 404: errorResponseSchema } } },
    async (request, reply) => {
      const { id } = request.params;
      try {
        await prisma.watchlistEntry.delete({ where: { id } });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          return reply.code(404).send({ error: `watchlist entry ${id} not found` });
        }
        throw e;
      }
    },
  );
};
