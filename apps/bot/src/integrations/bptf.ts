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

// v2 single listing (subset of fields we use). Synchronous create returns this.
interface V2ItemDocument {
  defindex?: number;
  quality?: number | { id?: number };
  craftable?: boolean;
  flag_cannot_craft?: boolean;
}
interface V2Listing {
  id: string;
  intent?: 'buy' | 'sell';
  item?: V2ItemDocument;
  currencies?: { keys?: number; metal?: number };
}

/** bp.tf v2 currencies map: always metal, keys only when non-zero. */
function currenciesOf(priceKeys: number, priceMetal: number): Record<string, number> {
  const c: Record<string, number> = { metal: round2(priceMetal) };
  if (priceKeys > 0) c.keys = priceKeys;
  return c;
}

export type CreateListingResult =
  | { bptfListingId: string | null; queued: boolean }
  | { skipped: true; reason: string };

/**
 * Create a listing — POST /v2/classifieds/listings (auth: ?token=USER_TOKEN).
 * v2 is SYNCHRONOUS: the response carries the real listing id, so we return it
 * immediately (no queue/reconcile dance like the old v1 path).
 *   BUY  → body.item = { item: name, quality, craftable }  (itemResolvable)
 *   SELL → body.id   = <inventory assetid>
 * Return shape kept identical to the v1 era; runtime now sets a real
 * bptfListingId with queued:false.
 */
export async function createListing(params: CreateListingParams): Promise<CreateListingResult> {
  if (params.intent === 'sell' && !params.assetId) {
    throw new Error('createListing: sell listings require assetId');
  }
  if (params.intent === 'buy' && params.assetId) {
    throw new Error('createListing: buy listings must not have assetId');
  }

  // BUY listings are resolved by item identity, so validate it. SELL listings are
  // resolved by assetId, so name/defindex aren't required there.
  if (params.intent === 'buy') {
    if (!params.defindex || params.defindex === 0) {
      logger.warn({ defindex: params.defindex }, 'createListing skipped: invalid defindex');
      return { skipped: true, reason: 'invalid_defindex' };
    }
    if (!params.quality && params.quality !== 0) {
      logger.warn({ defindex: params.defindex }, 'createListing skipped: missing quality');
      return { skipped: true, reason: 'missing_quality' };
    }
    if (!params.itemName || params.itemName.trim() === '') {
      logger.warn({ defindex: params.defindex }, 'createListing skipped: missing item name');
      return { skipped: true, reason: 'missing_name' };
    }
  }

  // Defense-in-depth: warn if metal isn't on bp.tf's display grid.
  const displayed = quantizeForDisplay(params.priceMetal);
  if (Math.abs(displayed - params.priceMetal) > 0.005) {
    logger.warn(
      { defindex: params.defindex, priceMetal: params.priceMetal, willDisplayAs: displayed },
      'createListing: priceMetal not on bp.tf display grid — description may differ from price card',
    );
  }

  const body: Record<string, unknown> = {
    currencies: currenciesOf(params.priceKeys, params.priceMetal),
    details: params.details,
  };
  if (params.intent === 'buy') {
    body.item = { item: params.itemName, quality: params.quality, craftable: params.craftable };
  } else {
    body.id = Number(params.assetId);
  }

  return limiter.schedule(async () => {
    const resp = await http.post('/v2/classifieds/listings', body, { params: { token: env.BPTF_USER_TOKEN } });
    if (resp.status < 200 || resp.status >= 300) {
      throw new BptfApiError(
        `bp.tf createListing returned ${resp.status}: ${JSON.stringify(resp.data)}`,
        resp.status,
        '/v2/classifieds/listings',
      );
    }
    const data = resp.data as V2Listing;
    if (!data?.id) {
      throw new BptfApiError('bp.tf createListing: response missing listing id', resp.status, '/v2/classifieds/listings');
    }
    return { bptfListingId: String(data.id), queued: false };
  });
}

/**
 * Update a listing's price in place — PATCH /v2/classifieds/listings/{id}.
 * Preferred over delete+recreate on price drift (one request, keeps bump age).
 */
export async function updateListingPrice(
  listingId: string,
  priceKeys: number,
  priceMetal: number,
  details?: string,
): Promise<void> {
  return limiter.schedule(async () => {
    const body: Record<string, unknown> = { currencies: currenciesOf(priceKeys, priceMetal) };
    if (details != null) body.details = details;
    const resp = await http.patch(`/v2/classifieds/listings/${encodeURIComponent(listingId)}`, body, {
      params: { token: env.BPTF_USER_TOKEN },
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new BptfApiError(
        `bp.tf updateListingPrice returned ${resp.status}: ${JSON.stringify(resp.data)}`,
        resp.status,
        '/v2/classifieds/listings/{id}',
      );
    }
  });
}

/** DELETE a listing by id — DELETE /v2/classifieds/listings/{id}. */
export async function deleteListing(listingId: string): Promise<void> {
  return limiter.schedule(async () => {
    const resp = await http.delete(`/v2/classifieds/listings/${encodeURIComponent(listingId)}`, {
      params: { token: env.BPTF_USER_TOKEN },
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new BptfApiError(`bp.tf deleteListing returned ${resp.status}`, resp.status, '/v2/classifieds/listings/{id}');
    }
  });
}

export interface MyListing {
  bptfListingId: string;
  intent: 'buy' | 'sell';
  defindex: number;
  quality: number;
  craftable: boolean;
  priceKeys: number;
  priceMetal: number;
}

interface V2ListResponse {
  results?: V2Listing[];
  listings?: V2Listing[];
}

function qualityId(q: number | { id?: number } | undefined): number {
  if (q == null) return 6;
  return typeof q === 'object' ? q.id ?? 6 : q;
}

function mapV2(l: V2Listing): MyListing | null {
  if (l.item?.defindex == null) return null;
  return {
    bptfListingId: String(l.id),
    intent: l.intent === 'sell' ? 'sell' : 'buy',
    defindex: l.item.defindex,
    quality: qualityId(l.item.quality),
    craftable: l.item.flag_cannot_craft ? false : l.item.craftable ?? true,
    priceKeys: l.currencies?.keys ?? 0,
    priceMetal: l.currencies?.metal ?? 0,
  };
}

/**
 * GET our active listings — GET /v2/classifieds/listings. Response shape is
 * mapped defensively (results[] or listings[]) since v2 pagination wasn't
 * exercised live yet; only bptfListingId is load-bearing for reconcile.
 */
export async function listMyListings(): Promise<MyListing[]> {
  return limiter.schedule(async () => {
    const resp = await http.get('/v2/classifieds/listings', {
      params: { token: env.BPTF_USER_TOKEN, limit: 100 },
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new BptfApiError(`bp.tf listMyListings returned ${resp.status}`, resp.status, '/v2/classifieds/listings');
    }
    const data = resp.data as V2ListResponse;
    const rows = data.results ?? data.listings ?? [];
    return rows.map(mapV2).filter((x): x is MyListing => x !== null);
  });
}

/** Shaped for the listingReconcile matcher (mostly vestigial now that v2 create is synchronous). */
export async function getMyListings(): Promise<
  Array<{ id: string; intent: number; defindex: number; quality: number; craftable: boolean; keys: number; metal: number }>
> {
  const rows = await listMyListings();
  return rows.map((l) => ({
    id: l.bptfListingId,
    intent: l.intent === 'buy' ? 0 : 1,
    defindex: l.defindex,
    quality: l.quality,
    craftable: l.craftable,
    keys: l.priceKeys,
    metal: l.priceMetal,
  }));
}
