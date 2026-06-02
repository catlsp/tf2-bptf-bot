import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { tradeSchema, tradeStatusSchema, listingIntentSchema } from '../lib/schemas.js';

const tradesQuerySchema = z.object({
  status: tradeStatusSchema.optional(),
  intent: listingIntentSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const tradesListResponseSchema = z.array(tradeSchema);

export const tradesRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/trades',
    { schema: { querystring: tradesQuerySchema, response: { 200: tradesListResponseSchema } } },
    async (request) => {
      const { status, intent, limit, offset } = request.query;
      return prisma.trade.findMany({
        where: {
          ...(status ? { status } : {}),
          ...(intent ? { intent } : {}),
        },
        include: { item: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
    },
  );
};
