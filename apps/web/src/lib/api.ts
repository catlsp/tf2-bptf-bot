import type {
  CreateWatchlistInput,
  DashboardStats,
  EventLog,
  InventoryItem,
  InventoryStatus,
  OurListing,
  Paginated,
  PriceSnapshot,
  Trade,
  TradeStatus,
  UpdateWatchlistInput,
  WatchlistEntry,
} from './types';

const BASE_URL = import.meta.env.VITE_API_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      signal,
      headers: body == null ? undefined : { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Network error — is the API running / SSH tunnel open?', 0);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return parsed as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  dashboard: (signal?: AbortSignal): Promise<DashboardStats> =>
    request('/api/dashboard', { signal }),

  orders: (
    params: { status?: string; skuKey?: string; limit?: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<Paginated<OurListing>> => request(`/api/orders${query(params)}`, { signal }),

  deleteOrder: (id: string): Promise<OurListing> =>
    request(`/api/orders/${id}`, { method: 'DELETE' }),

  watchlist: (signal?: AbortSignal): Promise<WatchlistEntry[]> =>
    request('/api/watchlist', { signal }),

  createWatchlist: (input: CreateWatchlistInput): Promise<WatchlistEntry> =>
    request('/api/watchlist', { method: 'POST', body: input }),

  updateWatchlist: (id: string, input: UpdateWatchlistInput): Promise<WatchlistEntry> =>
    request(`/api/watchlist/${id}`, { method: 'PATCH', body: input }),

  deleteWatchlist: (id: string): Promise<void> =>
    request(`/api/watchlist/${id}`, { method: 'DELETE' }),

  logs: (
    params: { type?: string; level?: string; from?: string; to?: string; limit?: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<Paginated<EventLog>> => request(`/api/logs${query(params)}`, { signal }),

  logTypes: (signal?: AbortSignal): Promise<string[]> => request('/api/logs/types', { signal }),

  inventory: (status: InventoryStatus | undefined, signal?: AbortSignal): Promise<InventoryItem[]> =>
    request(`/api/inventory${query({ status })}`, { signal }),

  trades: (
    params: { status?: TradeStatus; intent?: string; limit?: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<Trade[]> => request(`/api/trades${query(params)}`, { signal }),

  prices: (skuKey: string, days: number, signal?: AbortSignal): Promise<PriceSnapshot[]> =>
    request(`/api/prices/${encodeURIComponent(skuKey)}${query({ days })}`, { signal }),
};
