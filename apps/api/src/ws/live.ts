import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { serializeOurListing } from '../lib/serializers.js';
import { errMessage } from '../lib/errors.js';

// v1 live bridge: poll the DB every POLL_INTERVAL_MS for rows newer than the
// last high-water mark and broadcast the diff to subscribers. v2 (later) will
// swap polling for Postgres LISTEN/NOTIFY without changing the wire protocol.

const TOPICS = ['logs', 'orders', 'trades'] as const;
type Topic = (typeof TOPICS)[number];

type ChangeEvent = 'created' | 'updated' | 'deleted';

interface ServerMessage {
  topic: Topic;
  event: ChangeEvent | 'subscribed' | 'unsubscribed';
  data: unknown;
}

interface Client {
  socket: WebSocket;
  topics: Set<Topic>;
}

const POLL_INTERVAL_MS = 2000;
const OPEN = 1; // ws.WebSocket.OPEN

const clientMessageSchema = z.object({
  action: z.enum(['subscribe', 'unsubscribe']).default('subscribe'),
  topic: z.enum(TOPICS),
});

const clients = new Set<Client>();

// High-water marks. Seeded to "now" so a fresh connection only sees activity
// from after the server started, not the entire backlog.
let lastLogAt = new Date();
let lastOrderAt = new Date();
let lastTradeAt = new Date();

let poller: NodeJS.Timeout | null = null;

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== OPEN) return;
  socket.send(JSON.stringify(message));
}

function broadcast(topic: Topic, event: ChangeEvent, data: unknown): void {
  for (const client of clients) {
    if (client.topics.has(topic)) send(client.socket, { topic, event, data });
  }
}

function hasSubscribers(topic: Topic): boolean {
  for (const client of clients) {
    if (client.topics.has(topic)) return true;
  }
  return false;
}

async function pollLogs(): Promise<void> {
  const since = lastLogAt;
  const rows = await prisma.eventLog.findMany({
    where: { createdAt: { gt: since } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const row of rows) {
    broadcast('logs', 'created', row);
    if (row.createdAt > lastLogAt) lastLogAt = row.createdAt;
  }
}

async function pollOrders(): Promise<void> {
  const since = lastOrderAt;
  const rows = await prisma.ourListing.findMany({
    where: { refreshedAt: { gt: since } },
    orderBy: { refreshedAt: 'asc' },
    take: 100,
  });
  for (const row of rows) {
    const event: ChangeEvent =
      row.createdAt > since
        ? 'created'
        : row.status === 'deleting' || row.status === 'deleted'
          ? 'deleted'
          : 'updated';
    broadcast('orders', event, serializeOurListing(row));
    if (row.refreshedAt > lastOrderAt) lastOrderAt = row.refreshedAt;
  }
}

async function pollTrades(): Promise<void> {
  const since = lastTradeAt;
  const rows = await prisma.trade.findMany({
    where: { OR: [{ createdAt: { gt: since } }, { completedAt: { gt: since } }] },
    include: { item: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const row of rows) {
    const event: ChangeEvent = row.createdAt > since ? 'created' : 'updated';
    broadcast('trades', event, row);
    const newest = row.completedAt && row.completedAt > row.createdAt ? row.completedAt : row.createdAt;
    if (newest > lastTradeAt) lastTradeAt = newest;
  }
}

async function tick(log: FastifyInstance['log']): Promise<void> {
  try {
    const jobs: Array<Promise<void>> = [];
    if (hasSubscribers('logs')) jobs.push(pollLogs());
    if (hasSubscribers('orders')) jobs.push(pollOrders());
    if (hasSubscribers('trades')) jobs.push(pollTrades());
    await Promise.all(jobs);
  } catch (e) {
    log.warn({ err: errMessage(e) }, 'live ws poll failed');
  }
}

export function registerLiveWs(fastify: FastifyInstance): void {
  fastify.get('/ws', { websocket: true }, (connection) => {
    const socket = connection.socket;
    const client: Client = { socket, topics: new Set() };
    clients.add(client);

    socket.on('message', (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(socket, { topic: 'logs', event: 'subscribed', data: { error: 'invalid JSON' } });
        return;
      }

      const result = clientMessageSchema.safeParse(parsed);
      if (!result.success) {
        send(socket, { topic: 'logs', event: 'subscribed', data: { error: 'expected { action?, topic }' } });
        return;
      }

      const { action, topic } = result.data;
      if (action === 'unsubscribe') {
        client.topics.delete(topic);
        send(socket, { topic, event: 'unsubscribed', data: null });
      } else {
        client.topics.add(topic);
        send(socket, { topic, event: 'subscribed', data: null });
      }
    });

    const drop = (): void => {
      clients.delete(client);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  poller = setInterval(() => void tick(fastify.log), POLL_INTERVAL_MS);
}

export function stopLiveWs(): void {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
  for (const client of clients) {
    if (client.socket.readyState === OPEN) client.socket.close();
  }
  clients.clear();
}
