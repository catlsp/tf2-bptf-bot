import { useEffect } from 'react';
import { useUiStore } from './store';

export type LiveTopic = 'logs' | 'orders' | 'trades';
export type LiveEvent = 'created' | 'updated' | 'deleted' | 'subscribed' | 'unsubscribed';

export interface LiveMessage<T = unknown> {
  topic: LiveTopic;
  event: LiveEvent;
  data: T;
}

type Handler = (message: LiveMessage) => void;

const WS_URL = import.meta.env.VITE_WS_URL;
const MAX_RECONNECT_DELAY = 15000;

/**
 * Singleton WebSocket bridge to the API's /ws endpoint. Ref-counts subscriptions
 * per topic so multiple components can share one socket, re-subscribes every
 * topic on reconnect, and backs off exponentially when the API is unreachable
 * (e.g. the SSH tunnel dropped).
 */
class LiveClient {
  private socket: WebSocket | null = null;
  private readonly handlers = new Map<LiveTopic, Set<Handler>>();
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private open(): void {
    useUiStore.getState().setLiveStatus('connecting');
    const socket = new WebSocket(WS_URL);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = 1000;
      useUiStore.getState().setLiveStatus('open');
      for (const topic of this.handlers.keys()) this.rawSend('subscribe', topic);
    };

    socket.onmessage = (event) => {
      let message: LiveMessage;
      try {
        message = JSON.parse(event.data as string) as LiveMessage;
      } catch {
        return;
      }
      const set = this.handlers.get(message.topic);
      if (set) for (const handler of set) handler(message);
    };

    socket.onclose = () => {
      useUiStore.getState().setLiveStatus('closed');
      this.socket = null;
      if (this.handlers.size > 0) this.scheduleReconnect();
    };

    socket.onerror = () => socket.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
      this.open();
    }, this.reconnectDelay);
  }

  private rawSend(action: 'subscribe' | 'unsubscribe', topic: LiveTopic): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ action, topic }));
    }
  }

  subscribe(topic: LiveTopic, handler: Handler): () => void {
    let set = this.handlers.get(topic);
    const firstForTopic = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);

    if (!this.socket) {
      this.open();
    } else if (firstForTopic) {
      this.rawSend('subscribe', topic);
    }

    return () => {
      const current = this.handlers.get(topic);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(topic);
        this.rawSend('unsubscribe', topic);
      }
    };
  }
}

const liveClient = new LiveClient();

/**
 * Subscribe a (stable) handler to a live topic for the lifetime of the component.
 * Wrap `handler` in useCallback so the subscription isn't torn down every render.
 */
export function useLiveTopic(topic: LiveTopic, handler: Handler, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return liveClient.subscribe(topic, handler);
  }, [topic, handler, enabled]);
}
