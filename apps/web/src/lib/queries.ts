import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from './api';
import type {
  CreateWatchlistInput,
  DashboardStats,
  EventLog,
  InventoryItem,
  InventoryStatus,
  MarketItem,
  OurListing,
  Paginated,
  PriceSnapshot,
  Trade,
  TradeStatus,
  UpdateWatchlistInput,
  WatchlistEntry,
} from './types';

export const queryKeys = {
  dashboard: ['dashboard'] as const,
  orders: (params: OrdersParams) => ['orders', params] as const,
  watchlist: ['watchlist'] as const,
  logs: (params: LogsParams) => ['logs', params] as const,
  logTypes: ['logTypes'] as const,
  inventory: (status?: InventoryStatus) => ['inventory', status ?? 'all'] as const,
  trades: (params: TradesParams) => ['trades', params] as const,
  prices: (skuKey: string, days: number) => ['prices', skuKey, days] as const,
  market: ['market'] as const,
};

export interface OrdersParams {
  status?: string;
  skuKey?: string;
  limit: number;
  offset: number;
}

export interface LogsParams {
  type?: string;
  level?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export interface TradesParams {
  status?: TradeStatus;
  intent?: string;
  limit: number;
  offset: number;
}

export function useDashboard(): UseQueryResult<DashboardStats> {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: ({ signal }) => api.dashboard(signal),
    refetchInterval: 30_000,
  });
}

export function useOrders(params: OrdersParams): UseQueryResult<Paginated<OurListing>> {
  return useQuery({
    queryKey: queryKeys.orders(params),
    queryFn: ({ signal }) => api.orders(params, signal),
    placeholderData: (previous) => previous,
  });
}

export function useDeleteOrder(): UseMutationResult<OurListing, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteOrder(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['orders'] });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useWatchlist(): UseQueryResult<WatchlistEntry[]> {
  return useQuery({
    queryKey: queryKeys.watchlist,
    queryFn: ({ signal }) => api.watchlist(signal),
  });
}

export function useCreateWatchlist(): UseMutationResult<WatchlistEntry, Error, CreateWatchlistInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWatchlistInput) => api.createWatchlist(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.watchlist });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useUpdateWatchlist(): UseMutationResult<
  WatchlistEntry,
  Error,
  { id: string; input: UpdateWatchlistInput }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateWatchlistInput }) =>
      api.updateWatchlist(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.watchlist });
    },
  });
}

export function useDeleteWatchlist(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWatchlist(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.watchlist });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useLogs(params: LogsParams): UseQueryResult<Paginated<EventLog>> {
  return useQuery({
    queryKey: queryKeys.logs(params),
    queryFn: ({ signal }) => api.logs(params, signal),
    placeholderData: (previous) => previous,
  });
}

export function useLogTypes(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: queryKeys.logTypes,
    queryFn: ({ signal }) => api.logTypes(signal),
    staleTime: 60_000,
  });
}

export function useInventory(status?: InventoryStatus): UseQueryResult<InventoryItem[]> {
  return useQuery({
    queryKey: queryKeys.inventory(status),
    queryFn: ({ signal }) => api.inventory(status, signal),
  });
}

export function useTrades(params: TradesParams): UseQueryResult<Trade[]> {
  return useQuery({
    queryKey: queryKeys.trades(params),
    queryFn: ({ signal }) => api.trades(params, signal),
    placeholderData: (previous) => previous,
  });
}

export function usePrices(
  skuKey: string | undefined,
  days: number,
): UseQueryResult<PriceSnapshot[]> {
  return useQuery({
    queryKey: queryKeys.prices(skuKey ?? '', days),
    queryFn: ({ signal }) => api.prices(skuKey as string, days, signal),
    enabled: Boolean(skuKey),
  });
}

export function useMarket(): UseQueryResult<MarketItem[]> {
  return useQuery({
    queryKey: queryKeys.market,
    queryFn: ({ signal }) => api.market(signal),
    refetchInterval: 30_000,
  });
}
