import axios, { type AxiosInstance } from 'axios';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { BptfApiError } from '../lib/errors.js';
import { sleep, round2 } from '../lib/utils.js';
import { quantizeForDisplay } from '../pricing/listingPricer.js';

// backpack.tf REST client with a hard 60 req/min ceiling.
//
// Rate limiter: a queue drained by a token bucket. Tokens refill on a rolling
// 60s window, so we physically cannot exceed BPTF_MAX_REQ_PER_MIN no matter how
// many callers pile on. Every outbound request goes through schedule().

const BASE = 'https://backpack.tf/api';

class RateLimiter {
  private timestamps: number[] = [];
  private queue: Array<() => void> = [];
  private draining = false;

  constructor(private readonly maxPerMin: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => fn().then(resolve, reject));
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const waitMs = this.waitTime();
        if (waitMs > 0) {
          await sleep(waitMs);
          continue;
        }
        this.timestamps.push(Date.now());
        const job = this.queue.shift();
        job?.();
      }
    } finally {
      this.draining = false;
    }
  }

  private waitTime(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length < this.maxPerMin) return 0;
    const oldest = this.timestamps[0]!;
    return 60_000 - (now - oldest) + 5;
  }
}

const limiter = new RateLimiter(env.BPTF_MAX_REQ_PER_MIN);

// bp.tf's POST /classifieds/list/v1 has its own much stricter limit (~1 req / 120s),
// separate from the general 60/min budget. Serialize those POSTs with a minimum
// gap so we never trip it — and keep it independent so reads aren't blocked.
class IntervalLimiter {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly minGapMs: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return fn();
    };
    const result = this.chain.then(run, run); // serialize regardless of prior outcome
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// 130s gap = 120s bp.tf limit + 10s safety.
const classifiedsLimiter = new IntervalLimiter(130_000);

const http: AxiosInstance = axios.create({
  baseURL: BASE,
  timeout: 15_000,
  validateStatus: () => true,
});

async function get<T>(endpoint: string, params: Record<string, unknown>): Promise<T> {
  return limiter.schedule(async () => {
    const resp = await http.get(endpoint, { params: { key: env.BPTF_API_KEY, ...params } });
    if (resp.status !== 200) {
      throw new BptfApiError(`bp.tf ${endpoint} returned ${resp.status}`, resp.status, endpoint);
    }
    return resp.data as T;
  });
}

// --- Currency: bp.tf prices in keys + metal; we work in refined. ---
let cachedKeyRef = env.KEY_TO_REF_FALLBACK;

export function currentKeyRef(): number {
  return cachedKeyRef;
}

/** Convert a bp.tf price object {value, currency} into refined. */
function priceToRef(value: number | undefined, currency: string | undefined): number | null {
  if (value == null || !currency) return null;
  if (currency === 'metal' || currency === 'ref') return round2(value);
  if (currency === 'keys' || currency === 'key') return round2(value * cachedKeyRef);
  return null;
}

interface IGetPricesResponse {
  response: {
    success: number;
    message?: string;
    items: Record<
      string,
      {
        defindex: number[];
        prices: Record<string, { Tradable?: { Craftable?: Record<string, { value: number; currency: string; value_high?: number }> | Array<{ value: number; currency: string; value_high?: number }> } }>;
      }
    >;
  };
}

/**
 * Refresh the key→ref rate from bp.tf's own key price so all conversions stay
 * current. Called by the scanner before each pass.
 */
export async function refreshKeyPrice(): Promise<number> {
  try {
    const data = await get<IGetPricesResponse>('/IGetPrices/v4', { raw: 1 });
    const key = data.response?.items?.['Mann Co. Supply Crate Key'];
    const tradable = key?.prices?.['6']?.Tradable?.Craftable;
    const entry = Array.isArray(tradable) ? tradable[0] : tradable?.['0'];
    if (entry && entry.currency === 'metal') {
      cachedKeyRef = round2(entry.value);
      logger.debug({ keyRef: cachedKeyRef }, 'refreshed key price');
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'key price refresh failed; keeping previous/fallback');
  }
  return cachedKeyRef;
}

export interface AutopriceResult {
  skuKey: string;
  buyRef: number | null;
  sellRef: number | null;
}

interface ClassifiedsSearchResponse {
  buy?: { listings?: Array<{ steamid: string; currencies: { keys?: number; metal?: number }; bump?: number }> };
  sell?: { listings?: Array<{ steamid: string; currencies: { keys?: number; metal?: number }; bump?: number }> };
}

/**
 * Fetch the current classifieds for a SKU. Returns normalized listings in ref,
 * lowest-sell / highest-buy first. This is the workhorse the scanner uses to
 * derive fair value and spot undervalued sells.
 */
export async function fetchListings(params: {
  skuKey: string;
  defindex: number;
  quality: number;
  craftable: boolean;
}): Promise<{
  sell: Array<{ steamId: string; priceRef: number; bumpedAt?: number }>;
  buy: Array<{ steamId: string; priceRef: number; bumpedAt?: number }>;
}> {
  const data = await get<ClassifiedsSearchResponse>('/classifieds/search/v1', {
    token: env.BPTF_USER_TOKEN,
    item_names: 0,
    defindex: params.defindex,
    quality: params.quality,
    craftable: params.craftable ? 1 : -1,
    page_size: 30,
    fold: 1,
  });

  const norm = (
    listings: Array<{ steamid: string; currencies: { keys?: number; metal?: number }; bump?: number }> = [],
  ) =>
    listings
      .map((l) => ({
        steamId: l.steamid,
        priceRef: round2((l.currencies.keys ?? 0) * cachedKeyRef + (l.currencies.metal ?? 0)),
        bumpedAt: l.bump,
      }))
      .filter((l) => l.priceRef > 0);

  const sell = norm(data.sell?.listings).sort((a, b) => a.priceRef - b.priceRef);
  const buy = norm(data.buy?.listings).sort((a, b) => b.priceRef - a.priceRef);
  return { sell, buy };
}

/**
 * "Autoprice" for a SKU: bp.tf's suggested buy/sell. We derive it from the
 * community price index (IGetPrices) and fall back to the classifieds midpoint
 * if the index has no entry. priceToRef handles key/metal currency.
 */
export async function fetchAutoprice(params: {
  skuKey: string;
  name: string;
  quality: number;
}): Promise<AutopriceResult> {
  try {
    const data = await get<IGetPricesResponse>('/IGetPrices/v4', { raw: 1 });
    const item = data.response?.items?.[params.name];
    const tradable = item?.prices?.[String(params.quality)]?.Tradable?.Craftable;
    const entry = Array.isArray(tradable) ? tradable[0] : tradable?.['0'];
    if (entry) {
      const low = priceToRef(entry.value, entry.currency);
      const high = priceToRef(entry.value_high ?? entry.value, entry.currency);
      return { skuKey: params.skuKey, buyRef: low, sellRef: high ?? low };
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message, sku: params.skuKey }, 'autoprice lookup failed');
  }
  return { skuKey: params.skuKey, buyRef: null, sellRef: null };
}

// ============================================================================
// PHASE 2: Listing creation / management
// These hit the classifieds endpoints with the USER TOKEN (not the API key) and
// flow through the same rate limiter as everything else.
// ============================================================================

interface CreateListingParams {
  intent: 'buy' | 'sell';
  defindex: number;
  quality: number;
  craftable: boolean;
  itemName: string | null; // bp.tf needs item_name to resolve the item in its schema
  priceKeys: number;
  priceMetal: number;
  details: string;
  assetId?: string; // sell only — required for sell, MUST be undefined for buy
}

interface BptfCreateListingResponse {
  listings?: Record<string, { created?: number; error?: string }>;
  cap?: number;
  promotes_remaining?: number;
}

/**
 * POST bp.tf classifieds — create a new listing.
 * BUY: assetId omitted, item sent. SELL: assetId required (Phase 4+).
 * Endpoint: POST /classifieds/list/v1 (auth = user token).
 */
export type CreateListingResult =
  | { bptfListingId: string | null; queued: boolean }
  | { skipped: true; reason: string };

export async function createListing(params: CreateListingParams): Promise<CreateListingResult> {
  if (params.intent === 'sell' && !params.assetId) {
    throw new Error('createListing: sell listings require assetId');
  }
  if (params.intent === 'buy' && params.assetId) {
    throw new Error('createListing: buy listings must not have assetId');
  }

  // Refuse to send junk to bp.tf — a missing/zero defindex or missing quality
  // would create a garbage listing. Fail fast (no rate-limit slot consumed).
  if (!params.defindex || params.defindex === 0) {
    logger.warn({ defindex: params.defindex, quality: params.quality }, 'createListing skipped: invalid defindex');
    return { skipped: true, reason: 'invalid_defindex' };
  }
  if (!params.quality && params.quality !== 0) {
    logger.warn({ defindex: params.defindex, quality: params.quality }, 'createListing skipped: missing quality');
    return { skipped: true, reason: 'missing_quality' };
  }
  if (!params.itemName || params.itemName.trim() === '') {
    logger.warn({ defindex: params.defindex, quality: params.quality }, 'createListing skipped: missing item name');
    return { skipped: true, reason: 'missing_name' };
  }

  const item: Record<string, unknown> = {
    defindex: params.defindex,
    item_name: params.itemName, // required for bp.tf schema resolution (icon + title)
    quality: params.quality,
    craftable: params.craftable,
    killstreak: 0,
    australium: false,
    festivized: false,
    flag_cannot_craft: !params.craftable,
  };

  // Defense-in-depth: if the metal we're about to send isn't on bp.tf's display
  // grid, the rendered price card will differ from the {priceRef} in details.
  const displayed = quantizeForDisplay(params.priceMetal);
  if (Math.abs(displayed - params.priceMetal) > 0.005) {
    logger.warn(
      { defindex: params.defindex, priceMetal: params.priceMetal, willDisplayAs: displayed },
      'createListing: priceMetal not on bp.tf display grid — description may show a different price',
    );
  }

  const listingPayload: Record<string, unknown> = {
    intent: params.intent === 'buy' ? 0 : 1, // bp.tf: 0=buy, 1=sell
    currencies: { keys: params.priceKeys, metal: params.priceMetal },
    details: params.details,
  };

  if (params.intent === 'buy') listingPayload.item = item;
  else listingPayload.id = params.assetId;

  return classifiedsLimiter.schedule(async () => {
    const resp = await http.post('/classifieds/list/v1', {
      token: env.BPTF_USER_TOKEN,
      listings: [listingPayload],
    });

    if (resp.status !== 200) {
      throw new BptfApiError(
        `bp.tf createListing returned ${resp.status}: ${JSON.stringify(resp.data)}`,
        resp.status,
        '/classifieds/list/v1',
      );
    }

    const data = resp.data as BptfCreateListingResponse;
    const firstKey = Object.keys(data.listings ?? {})[0];
    const entry = firstKey ? data.listings?.[firstKey] : undefined;

    if (!entry) {
      throw new BptfApiError('bp.tf createListing: no response entry', 200, '/classifieds/list/v1');
    }
    if (entry.error) {
      throw new BptfApiError(`bp.tf createListing failed: ${entry.error}`, 200, '/classifieds/list/v1');
    }
    // bp.tf classifieds/list/v1 is async since 2024+: response.created is a queue counter,
    // NOT the real listing id. The real id arrives ~30-60s later and must be fetched via
    // GET /classifieds/listings/v1. See jobs/listingReconcile.ts.
    return { bptfListingId: null, queued: true };
  });
}

/** DELETE a listing by bp.tf id. Endpoint: DELETE /classifieds/delete/v1. */
export async function deleteListing(bptfListingId: string): Promise<void> {
  return limiter.schedule(async () => {
    const resp = await http.delete('/classifieds/delete/v1', {
      data: { token: env.BPTF_USER_TOKEN, listing_ids: [bptfListingId] },
    });
    if (resp.status !== 200) {
      throw new BptfApiError(`bp.tf deleteListing returned ${resp.status}`, resp.status, '/classifieds/delete/v1');
    }
  });
}

interface BptfMyListingsResponse {
  listings?: Array<{
    id: string;
    intent: number;
    item?: { defindex: number; quality: number; flag_cannot_craft?: boolean };
    currencies: { keys?: number; metal?: number };
    details?: string;
    bump?: number;
    created?: number;
  }>;
  cap?: number;
}

export interface MyListing {
  bptfListingId: string;
  intent: 'buy' | 'sell';
  defindex: number;
  quality: number;
  craftable: boolean;
  priceKeys: number;
  priceMetal: number;
  bumpedAt?: number;
  createdAt?: number;
}

/** GET our active listings on bp.tf, to reconcile DB state. Endpoint: GET /classifieds/listings/v1. */
export async function listMyListings(): Promise<MyListing[]> {
  return limiter.schedule(async () => {
    const resp = await http.get('/classifieds/listings/v1', { params: { token: env.BPTF_USER_TOKEN } });
    if (resp.status !== 200) {
      throw new BptfApiError(`bp.tf listMyListings returned ${resp.status}`, resp.status, '/classifieds/listings/v1');
    }
    const data = resp.data as BptfMyListingsResponse;
    return (data.listings ?? [])
      .filter((l) => l.item?.defindex !== undefined && l.item?.quality !== undefined)
      .map((l) => ({
        bptfListingId: l.id,
        intent: l.intent === 0 ? ('buy' as const) : ('sell' as const),
        defindex: l.item!.defindex,
        quality: l.item!.quality,
        craftable: !l.item?.flag_cannot_craft,
        priceKeys: l.currencies?.keys ?? 0,
        priceMetal: l.currencies?.metal ?? 0,
        bumpedAt: l.bump,
        createdAt: l.created,
      }));
  });
}

/**
 * GET bp.tf my listings, shaped for the listingReconcile matcher. Resolves the
 * real listing id after async (queued) creation.
 */
export async function getMyListings(): Promise<
  Array<{
    id: string;
    intent: number;
    defindex: number;
    quality: number;
    craftable: boolean;
    keys: number;
    metal: number;
  }>
> {
  return limiter.schedule(async () => {
    const resp = await http.get('/classifieds/listings/v1', { params: { token: env.BPTF_USER_TOKEN } });
    if (resp.status !== 200) {
      throw new BptfApiError(`bp.tf getMyListings returned ${resp.status}`, resp.status, '/classifieds/listings/v1');
    }
    const data = resp.data as BptfMyListingsResponse;
    return (data.listings ?? [])
      .filter((l) => l.item?.defindex !== undefined)
      .map((l) => ({
        id: l.id,
        intent: l.intent,
        defindex: l.item!.defindex,
        quality: l.item!.quality,
        craftable: l.item!.flag_cannot_craft !== true,
        keys: l.currencies.keys ?? 0,
        metal: l.currencies.metal ?? 0,
      }));
  });
}
