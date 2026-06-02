import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Prisma } from '@bptf/db';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { watchlistEntrySchema, errorResponseSchema } from '../lib/schemas.js';

const createBodySchema = z.object({
  skuKey: z.string().min(1),
  maxBuyRef: z.number().positive(),
  minSellRef: z.number().positive().nullable().optional(),
  priority: z.number().int().optional(),
  notes: z.string().nullable().optional(),
});

const updateBodySchema = z
  .object({
    maxBuyRef: z.number().positive(),
    minSellRef: z.number().positive().nullable(),
    active: z.boolean(),
    priority: z.number().int(),
    notes: z.string().nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field must be provided' });

const entryParamsSchema = z.object({
  id: z.string().min(1),
});

const watchlistListResponseSchema = z.array(watchlistEntrySchema);

export const watchlistRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/watchlist', { schema: { response: { 200: watchlistListResponseSchema } } }, async () => {
    return prisma.watchlistEntry.findMany({ orderBy: [{ priority: 'desc' }, { skuKey: 'asc' }] });
  });

  app.post(
    '/watchlist',
    {
      schema: {
        body: createBodySchema,
        response: { 201: watchlistEntrySchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { skuKey, maxBuyRef, minSellRef, priority, notes } = request.body;
      try {
        const created = await prisma.watchlistEntry.create({
          data: {
            skuKey,
            maxBuyRef,
            minSellRef: minSellRef ?? null,
            ...(priority == null ? {} : { priority }),
            notes: notes ?? null,
          },
        });
        return reply.code(201).send(created);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return reply.code(409).send({ error: `watchlist entry for "${skuKey}" already exists` });
        }
        throw e;
      }
    },
  );

  app.patch(
    '/watchlist/:id',
    {
      schema: {
        params: entryParamsSchema,
        body: updateBodySchema,
        response: { 200: watchlistEntrySchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const updated = await prisma.watchlistEntry.update({ where: { id }, data: request.body });
        return updated;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          return reply.code(404).send({ error: `watchlist entry ${id} not found` });
        }
        throw e;
      }
    },
  );

  app.delete(
    '/watchlist/:id',
    {
      schema: {
        params: entryParamsSchema,
        response: { 204: z.null(), 404: errorResponseSchema },
      },
    },
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
