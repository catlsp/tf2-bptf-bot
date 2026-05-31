import WebSocket from 'ws';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { applyUpdate, applyDelete, type WsListingPayload } from '../orderbook/orderBook.js';

// bp.tf public listings WebSocket. Streams listing-update / listing-delete events
// 24/7. We feed updates into the Redis order book. Auto-reconnects with capped
// exponential backoff; a bad message or a Redis blip never crashes the bot.

const WS_URL = 'wss://ws.backpack.tf/events';
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

let ws: WebSocket | null = null;
let stopped = false;
let attempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

interface WsEvent {
  id?: string;
  event?: string;
  payload?: WsListingPayload | string;
}

function handleEvent(evt: WsEvent): void {
  if (!evt || typeof evt !== 'object' || !evt.event) return;
  try {
    if (evt.event === 'listing-update') {
      const payload = evt.payload as WsListingPayload;
      if (payload?.appid != null && payload.appid !== 440) return; // TF2 only
      void applyUpdate(payload).catch((e) => logger.warn({ err: errMessage(e) }, '[ob] applyUpdate failed'));
    } else if (evt.event === 'listing-delete') {
      const id = typeof evt.payload === 'string' ? evt.payload : (evt.payload as WsListingPayload)?.id;
      if (id) void applyDelete(id).catch((e) => logger.warn({ err: errMessage(e) }, '[ob] applyDelete failed'));
    }
  } catch (e) {
    logger.warn({ err: errMessage(e) }, '[ws] event handler error');
  }
}

function handleMessage(raw: WebSocket.RawData): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    logger.warn({ raw: raw.toString().slice(0, 200) }, '[ws] invalid JSON message, skipping');
    return;
  }
  // bp.tf sends either a single event or a batch array.
  if (Array.isArray(parsed)) {
    for (const e of parsed) handleEvent(e as WsEvent);
  } else {
    handleEvent(parsed as WsEvent);
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  attempt++;
  logger.info({ attempt, delayMs: delay }, '[ws] reconnecting');
  reconnectTimer = setTimeout(connect, delay);
}

function connect(): void {
  if (stopped) return;
  logger.info({ url: WS_URL }, '[ws] connecting');
  ws = new WebSocket(WS_URL, { headers: { 'batch-test': '1' } });

  ws.on('open', () => {
    attempt = 0;
    logger.info(`[ws] connected to ${WS_URL}`);
  });

  ws.on('message', handleMessage);

  ws.on('error', (err) => {
    logger.warn({ err: err.message }, '[ws] socket error');
    // 'close' fires after 'error' and drives the reconnect.
  });

  ws.on('close', (code, reason) => {
    logger.info({ code, reason: reason.toString() }, '[ws] disconnected');
    ws = null;
    scheduleReconnect();
  });

  // bp.tf pings; respond to keep the connection alive.
  ws.on('ping', () => ws?.pong());
}

export function start(): void {
  stopped = false;
  attempt = 0;
  connect();
}

export function stop(): void {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    logger.info('[ws] stopping');
    ws.removeAllListeners('close');
    ws.close();
    ws = null;
  }
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
