import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { env } from './lib/env.js';
import { checkDb } from './lib/db.js';
import { errMessage } from './lib/errors.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { ordersRoutes } from './routes/orders.js';
import { watchlistRoutes } from './routes/watchlist.js';
import { logsRoutes } from './routes/logs.js';
import { inventoryRoutes } from './routes/inventory.js';
import { tradesRoutes } from './routes/trades.js';
import { pricesRoutes } from './routes/prices.js';
import { marketRoutes } from './routes/market.js';
import { steamInventoryRoutes } from './routes/steamInventory.js';
import { registerLiveWs, stopLiveWs } from './ws/live.js';

// Sole entry point for the management-panel API. Boots Fastify, wires the zod
// type provider, mounts the REST routes under /api and the live WebSocket at
// /ws. Nothing runs on import — everything is gated behind main().

async function buildServer() {
  const isDev = env.NODE_ENV !== 'production';

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      base: { app: 'bptf-api' },
      ...(isDev
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,app' },
            },
          }
        : {}),
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Surface validation failures as 400 with a readable body instead of a 500.
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error.message }, 'request failed');
    } else {
      request.log.warn({ err: error.message }, 'request rejected');
    }
    reply.code(status).send({ error: error.message });
  });

  await app.register(cors, { origin: env.CORS_ORIGIN });
  await app.register(websocket);

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      await api.register(dashboardRoutes);
      await api.register(ordersRoutes);
      await api.register(watchlistRoutes);
      await api.register(logsRoutes);
      await api.register(inventoryRoutes);
      await api.register(tradesRoutes);
      await api.register(pricesRoutes);
      await api.register(marketRoutes);
      await api.register(steamInventoryRoutes);
    },
    { prefix: '/api' },
  );

  registerLiveWs(app);

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();

  await checkDb();
  app.log.info('neon postgres connected');

  await app.listen({ port: env.PORT, host: env.HOST });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    stopLiveWs();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  // No Fastify logger yet if boot failed this early — stderr is the only sink.
  process.stderr.write(`fatal boot error: ${errMessage(e)}\n`);
  process.exit(1);
});
