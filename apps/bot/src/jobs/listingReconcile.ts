import { prisma, logEvent } from '../integrations/db.js';
import { getMyListings } from '../integrations/bptf.js';
import { logger } from '../lib/logger.js';
import { errMessage } from '../lib/errors.js';
import { env } from '../config/index.js';
import { parseSku } from '../util/itemToSku.js';

// Reconcile pending listings against bp.tf my-listings.
//
// bp.tf /classifieds/list/v1 is async — POST returns a queue counter, not a real
// id. This job fetches our active listings from bp.tf and matches them to pending
// DB rows by (intent + defindex + quality + craftable + keys + metal). The match
// item attributes come from parsing skuKey, since OurListing stores skuKey (not
// defindex/quality/craftable columns).
//
// On match: bptfListingId set + status pending -> active.
// Pending rows older than 10 min with no match -> status 'failed'.

const RECONCILE_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 30_000;
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

export async function reconcileListings(): Promise<void> {
  const startedAt = Date.now();
  try {
    // Cheap exit: don't hit the bp.tf API if there's nothing to resolve.
    const pending = await prisma.ourListing.findMany({ where: { status: 'pending', bptfListingId: null } });
    if (pending.length === 0) {
      logger.debug('[reconcile] no pending listings');
      return;
    }

    const remote = await getMyListings();
    let resolved = 0;
    let failed = 0;

    for (const row of pending) {
      const { defindex, quality, craftable } = parseSku(row.skuKey);
      const intentNum = row.intent === 'buy' ? 0 : 1;
      const priceKeys = Math.floor(Number(row.priceKeys ?? 0));
      const priceMetal = Number(row.priceMetal ?? row.priceRef ?? 0);

      const match = remote.find(
        (r) =>
          r.intent === intentNum &&
          r.defindex === defindex &&
          r.quality === quality &&
          r.craftable === craftable &&
          r.keys === priceKeys &&
          Math.abs(r.metal - priceMetal) < 0.01,
      );

      if (match) {
        await prisma.ourListing.update({ where: { id: row.id }, data: { bptfListingId: match.id, status: 'active' } });
        resolved++;
        logger.info({ skuKey: row.skuKey, bptfId: match.id }, '[reconcile] pending → active');
      } else if (Date.now() - row.refreshedAt.getTime() > PENDING_TIMEOUT_MS) {
        await prisma.ourListing.update({ where: { id: row.id }, data: { status: 'failed' } });
        failed++;
        logger.warn(
          { skuKey: row.skuKey, ageMin: Math.round((Date.now() - row.refreshedAt.getTime()) / 60000) },
          '[reconcile] pending → failed (timeout)',
        );
      }
    }

    if (resolved > 0 || failed > 0) {
      await logEvent({
        type: 'listing.reconcile',
        level: 'info',
        message: `reconcile: ${resolved} resolved, ${failed} failed of ${pending.length} pending`,
        payload: { resolved, failed, pending: pending.length, remote: remote.length, durationMs: Date.now() - startedAt },
      });
    }
  } catch (err) {
    logger.error({ err: errMessage(err) }, '[reconcile] failed');
  }
}

let timer: NodeJS.Timeout | null = null;
let firstRun: NodeJS.Timeout | null = null;

export function startListingReconcile(): void {
  if (env.PAPER_LISTINGS) {
    logger.info('listing reconcile disabled (PAPER_LISTINGS=true)');
    return;
  }
  firstRun = setTimeout(() => void reconcileListings(), FIRST_RUN_DELAY_MS);
  timer = setInterval(() => void reconcileListings(), RECONCILE_INTERVAL_MS);
}

export function stopListingReconcile(): void {
  if (timer) clearInterval(timer);
  if (firstRun) clearTimeout(firstRun);
  timer = null;
  firstRun = null;
}
