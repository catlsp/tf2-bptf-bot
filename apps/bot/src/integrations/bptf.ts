import axios, { type AxiosInstance } from 'axios';
import { env } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { BptfApiError } from '../lib/errors.js';
import { sleep, round2 } from '../lib/utils.js';

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
