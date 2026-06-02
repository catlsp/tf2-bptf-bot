import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { inventoryItemSchema, inventoryStatusSchema } from '../lib/schemas.js';

const inventoryQuerySchema = z.object({
  status: inventoryStatusSchema.optional(),
});

const inventoryListResponseSchema = z.array(inventoryItemSchema);

export const inventoryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/inventory',
    { schema: { querystring: inventoryQuerySchema, response: { 200: inventoryListResponseSchema } } },
    async (request) => {
      const { status } = request.query;
      return prisma.inventoryItem.findMany({
        where: status ? { status } : undefined,
        include: { item: true },
        orderBy: { acquiredAt: 'desc' },
      });
    },
  );
};
