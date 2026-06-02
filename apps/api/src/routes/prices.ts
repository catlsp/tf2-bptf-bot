import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { priceSnapshotSchema } from '../lib/schemas.js';

const pricesParamsSchema = z.object({
  skuKey: z.string().min(1),
});

const pricesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
});

const pricesListResponseSchema = z.array(priceSnapshotSchema);

export const pricesRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/prices/:skuKey',
    {
      schema: {
        params: pricesParamsSchema,
        querystring: pricesQuerySchema,
        response: { 200: pricesListResponseSchema },
      },
    },
    async (request) => {
      const { skuKey } = request.params;
      const { days } = request.query;

      const item = await prisma.item.findUnique({ where: { skuKey }, select: { id: true } });
      if (!item) return [];

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return prisma.priceSnapshot.findMany({
        where: { itemId: item.id, capturedAt: { gte: since } },
        orderBy: { capturedAt: 'asc' },
      });
    },
  );
};
