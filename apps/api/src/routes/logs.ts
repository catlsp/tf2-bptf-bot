import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Prisma } from '@bptf/db';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { eventLogSchema, eventLogLevelSchema } from '../lib/schemas.js';

const logsQuerySchema = z.object({
  type: z.string().optional(),
  level: eventLogLevelSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const logsListResponseSchema = z.object({
  data: z.array(eventLogSchema),
  total: z.number(),
});

const logTypesResponseSchema = z.array(z.string());

export const logsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/logs',
    { schema: { querystring: logsQuerySchema, response: { 200: logsListResponseSchema } } },
    async (request) => {
      const { type, level, from, to, limit, offset } = request.query;

      const createdAt: Prisma.DateTimeFilter = {};
      if (from) createdAt.gte = from;
      if (to) createdAt.lte = to;

      const where: Prisma.EventLogWhereInput = {
        ...(type ? { type } : {}),
        ...(level ? { level } : {}),
        ...(from || to ? { createdAt } : {}),
      };

      const [data, total] = await Promise.all([
        prisma.eventLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
        prisma.eventLog.count({ where }),
      ]);

      return { data, total };
    },
  );

  // Distinct `type` values powering the Logs page filter dropdown, so the UI
  // never has to hardcode the event taxonomy. groupBy compiles to a GROUP BY
  // that uses the (type, createdAt) index; a `distinct` findMany on this table
  // plans poorly and stalls, so we deliberately avoid it here.
  app.get('/logs/types', { schema: { response: { 200: logTypesResponseSchema } } }, async () => {
    const rows = await prisma.eventLog.groupBy({ by: ['type'], orderBy: { type: 'asc' } });
    return rows.map((r) => r.type);
  });
};
