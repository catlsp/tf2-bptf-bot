import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../lib/db.js';

// scan.completed rows are written by the bot's scanner with this payload shape
// (apps/bot/src/jobs/scanner.ts). passthrough keeps forward-compat if the bot
// adds fields later.
const scanCompletedPayloadSchema = z
  .object({
    skus: z.number(),
    durationMs: z.number(),
  })
  .passthrough();

const dashboardResponseSchema = z.object({
  activeOurListings: z.number(),
  watchlistSize: z.number(),
  recentErrors: z.number(),
  recentScanCompleted: z
    .object({
      capturedAt: z.date(),
      durationMs: z.number(),
      skuCount: z.number(),
    })
    .nullable(),
  totalEventLogToday: z.number(),
});

type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

export const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/dashboard', { schema: { response: { 200: dashboardResponseSchema } } }, async () => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const [activeOurListings, watchlistSize, recentErrors, totalEventLogToday, lastScan] = await Promise.all([
      prisma.ourListing.count({ where: { status: 'active' } }),
      // Tracked SKUs = items the bot has priced at least once (the live watch set),
      // not the per-SKU override table.
      prisma.item.count({ where: { prices: { some: {} } } }),
      prisma.eventLog.count({ where: { level: 'error', createdAt: { gte: dayAgo } } }),
      prisma.eventLog.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.eventLog.findFirst({ where: { type: 'scan.completed' }, orderBy: { createdAt: 'desc' } }),
    ]);

    let recentScanCompleted: DashboardResponse['recentScanCompleted'] = null;
    if (lastScan) {
      const parsed = scanCompletedPayloadSchema.safeParse(lastScan.payload);
      if (parsed.success) {
        recentScanCompleted = {
          capturedAt: lastScan.createdAt,
          durationMs: parsed.data.durationMs,
          skuCount: parsed.data.skus,
        };
      }
    }

    return { activeOurListings, watchlistSize, recentErrors, totalEventLogToday, recentScanCompleted };
  });
};
