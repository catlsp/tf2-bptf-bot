import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { ourListingSchema, errorResponseSchema } from '../lib/schemas.js';
import { serializeOurListing } from '../lib/serializers.js';

const ordersQuerySchema = z.object({
  status: z.string().optional(),
  skuKey: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ordersListResponseSchema = z.object({
  data: z.array(ourListingSchema),
  total: z.number(),
});

const orderParamsSchema = z.object({
  id: z.string().min(1),
});

export const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/orders',
    { schema: { querystring: ordersQuerySchema, response: { 200: ordersListResponseSchema } } },
    async (request) => {
      const { status, skuKey, limit, offset } = request.query;
      const where = {
        ...(status ? { status } : {}),
        ...(skuKey ? { skuKey: { contains: skuKey, mode: 'insensitive' as const } } : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.ourListing.findMany({ where, orderBy: { refreshedAt: 'desc' }, take: limit, skip: offset }),
        prisma.ourListing.count({ where }),
      ]);

      return { data: rows.map(serializeOurListing), total };
    },
  );

  // Soft-delete: flag the row for the bot to remove from bp.tf. We never delete
  // OurListing rows physically here — the bot's reconcile loop owns the bp.tf
  // side and clears them once the remote listing is gone. refreshedAt is bumped
  // so the WebSocket poller picks the change up.
  app.delete(
    '/orders/:id',
    {
      schema: {
        params: orderParamsSchema,
        response: { 200: ourListingSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await prisma.ourListing.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: `OurListing ${id} not found` });
      }

      const updated = await prisma.ourListing.update({
        where: { id },
        data: { status: 'deleting', deletedAt: new Date(), refreshedAt: new Date() },
      });

      return serializeOurListing(updated);
    },
  );
};
