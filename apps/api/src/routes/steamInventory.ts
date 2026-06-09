import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../lib/db.js';

// Read-only live snapshot of the bot's Steam inventory (balance + non-currency
// items), written to BotConfig by the bot's inventory sync every few minutes.
// Distinct from /api/inventory (the InventoryItem positions ledger): this is what
// is actually sitting in the shared Steam account right now.

const INVENTORY_SNAPSHOT_KEY = 'steam:inventory';

const balanceSchema = z.object({
  keys: z.number(),
  refined: z.number(),
  reclaimed: z.number(),
  scrap: z.number(),
  refinedTotal: z.number(),
});

const steamInventorySchema = z
  .object({
    at: z.string(),
    balance: balanceSchema,
    itemCount: z.number(),
    items: z.array(z.object({ assetId: z.string(), name: z.string() })),
  })
  .nullable();

export const steamInventoryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/steam-inventory', { schema: { response: { 200: steamInventorySchema } } }, async () => {
    const row = await prisma.botConfig.findUnique({ where: { key: INVENTORY_SNAPSHOT_KEY } });
    if (!row) return null;
    try {
      const parsed = steamInventorySchema.parse(JSON.parse(row.value));
      return parsed;
    } catch {
      return null;
    }
  });
};
