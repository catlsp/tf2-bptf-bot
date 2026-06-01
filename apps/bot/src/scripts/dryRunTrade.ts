/**
 * End-to-end dry run. Pulls candidate SKUs (watch-list + currently owned),
 * builds market snapshots, and evaluates trade decisions + buy/sell listing
 * prices. Strictly read-only — no offers sent, no listings created, no DB writes.
 *
 * Usage: pnpm --filter @bptf/bot run dryrun [limit]
 */
import { prisma } from '../integrations/db.js';
import { redis } from '../integrations/redis.js';
import { evaluate, evaluateListingBuyPrice, evaluateListingSellPrice } from '../pricing/strategy.js';
import { buildMarketSnapshot, parseSkuKey } from '../jobs/listingRefresh.js';
import { getOwnedListableItems } from '../inventory/inventoryService.js';

// Same key the order-book/watch-list writer uses (see listingRefresh.ts).
const WATCHLIST_KEY = 'bptf:ob:watch';

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 20);
  const watch = (await redis.smembers(WATCHLIST_KEY)).slice(0, limit);
  const owned = await getOwnedListableItems();
  const ownedSkus = [...new Set(owned.map((o) => o.skuKey))];
  const allSkus = [...new Set([...watch, ...ownedSkus])];

  console.log(`\n=== Dry-run: ${watch.length} watch-list + ${ownedSkus.length} owned = ${allSkus.length} unique ===\n`);

  let tradeBuys = 0;
  let tradeSells = 0;
  let listingBuys = 0;
  let listingSells = 0;
  let skipped = 0;

  for (const skuKey of allSkus) {
    const meta = parseSkuKey(skuKey);
    if (!meta) {
      skipped++;
      continue;
    }
    const market = await buildMarketSnapshot(skuKey, meta);
    if (!market) {
      skipped++;
      continue;
    }

    const tradeDecision = evaluate({ skuKey, name: skuKey, market: { ...market, skuKey, sellCount: 0, buyCount: 0 } });
    const buyListing = evaluateListingBuyPrice({ skuKey, market });
    const sellListing = ownedSkus.includes(skuKey) ? evaluateListingSellPrice({ skuKey, market }) : null;

    if (tradeDecision?.intent === 'BUY') tradeBuys++;
    if (tradeDecision?.intent === 'SELL') tradeSells++;
    if (buyListing) listingBuys++;
    if (sellListing) listingSells++;

    console.log(
      JSON.stringify(
        { skuKey, owned: ownedSkus.includes(skuKey), market, tradeDecision, buyListing, sellListing },
        null,
        2,
      ),
    );
  }

  console.log(`\n=== Summary ===`);
  console.log(`Trade decisions: ${tradeBuys} BUY / ${tradeSells} SELL`);
  console.log(`Listing prices:  ${listingBuys} BUY / ${listingSells} SELL`);
  console.log(`Skipped (no data): ${skipped}`);

  // Historical context — last 10 trades the bot has recorded.
  const recentTrades = await prisma.trade.findMany({ orderBy: { createdAt: 'desc' }, take: 10 });
  console.log(`\n=== Last 10 trades in DB ===`);
  for (const t of recentTrades) {
    console.log(
      `${t.createdAt.toISOString()} | ${t.intent} | priceRef=${t.priceRef} | profit=${t.profitRef ?? 'n/a'} | ${t.status}`,
    );
  }
  if (recentTrades.length === 0) console.log('(none — bot has never completed a trade)');

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
