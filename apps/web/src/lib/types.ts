// Wire DTOs returned by @bptf/api. Dates arrive as ISO strings and Decimals as
// numbers (the API serializes them). These mirror apps/api/src/lib/schemas.ts —
// the API's response schema is the contract this app consumes.

export type InventoryStatus = 'HELD' | 'LISTED' | 'RESERVED' | 'SOLD';
export type ListingIntent = 'BUY' | 'SELL';
export type TradeStatus =
  | 'PENDING'
  | 'SENT'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CANCELED'
  | 'FAILED';
export type EventLogLevel = 'info' | 'warn' | 'error';

export interface Item {
  id: string;
  defindex: number;
  quality: number;
  craftable: boolean;
  killstreak: number;
  australium: boolean;
  effect: number | null;
  skuKey: string;
  name: string;
  createdAt: string;
}

export interface OurListing {
  id: string;
  bptfListingId: string | null;
  skuKey: string;
  intent: string;
  priceRef: number;
  priceKeys: number;
  priceMetal: number;
  fairValueRef: number;
  details: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  refreshedAt: string;
  deletedAt: string | null;
}

export interface WatchlistEntry {
  id: string;
  skuKey: string;
  maxBuyRef: number;
  minSellRef: number | null;
  active: boolean;
  priority: number;
  notes: string | null;
}

export interface EventLog {
  id: string;
  type: string;
  level: string;
  message: string;
  payload: unknown;
  createdAt: string;
}

export interface InventoryItem {
  id: string;
  assetId: string;
  itemId: string;
  acquiredAt: string;
  acquiredPriceRef: number;
  status: InventoryStatus;
  reservedFor: string | null;
  item: Item;
}

export interface Trade {
  id: string;
  steamOfferId: string;
  partnerSteamId: string;
  itemId: string;
  intent: ListingIntent;
  priceRef: number;
  fairValueRef: number;
  profitRef: number | null;
  status: TradeStatus;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  item: Item;
}

export interface PriceSnapshot {
  id: string;
  itemId: string;
  buyRef: number | null;
  sellRef: number | null;
  source: string;
  capturedAt: string;
}

export interface MarketItem {
  itemId: string;
  skuKey: string;
  name: string;
  buyRef: number | null;
  sellRef: number | null;
  spreadRef: number | null;
  source: string;
  capturedAt: string;
}

export interface DashboardStats {
  activeOurListings: number;
  watchlistSize: number;
  recentErrors: number;
  recentScanCompleted: { capturedAt: string; durationMs: number; skuCount: number } | null;
  totalEventLogToday: number;
}

export interface Paginated<T> {
  data: T[];
  total: number;
}

// Input payloads for mutations.
export interface CreateWatchlistInput {
  skuKey: string;
  maxBuyRef: number;
  minSellRef?: number | null;
  priority?: number;
  notes?: string | null;
}

export interface UpdateWatchlistInput {
  maxBuyRef?: number;
  minSellRef?: number | null;
  active?: boolean;
  priority?: number;
  notes?: string | null;
}
