/**
 * End-to-end dry run. Pulls candidate SKUs (watch-list + currently owned),
 * builds market snapshots, and evaluates trade decisions + buy/sell listing
 * prices. Strictly read-only — no offers sent, no listings created, no DB writes.
 *
 * Usage: pnpm --filter @bptf/bot run dryrun [limit]
 */
import { prisma } from '../integrations/db.js';
import { redis } from '../integrations/redis.js';
import { env } from '../config/index.js';
import {
  evaluate,
  evaluateListingBuyPrice,
  evaluateListingSellPrice,
  priceCompetitiveBuy,
  priceCompetitiveSell,
} from '../pricing/strategy.js';
import { buildMarketSnapshot, parseSkuKey } from '../jobs/listingRefresh.js';
import { getOrderBook } from '../orderbook/orderBook.js';
import { refreshPriceOracle, getRefPrice } from '../pricing/priceOracle.js';
import { getOwnedListableItems } from '../inventory/inventoryService.js';

// Same key the order-book/watch-list writer uses (see listingRefresh.ts).
const WATCHLIST_KEY = 'bptf:ob:watch';

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 20);
  await refreshPriceOracle(); // populate pricedb reference prices for this run
  const watch = (await redis.smembers(WATCHLIST_KEY)).slice(0, limit);
  const owned = await getOwnedListableItems();
  const ownedSkus = [...new Set(owned.map((o) => o.skuKey))];
  const allSkus = [...new Set([...watch, ...ownedSkus])];

  console.log(`\n=== Dry-run: ${watch.length} watch-list + ${ownedSkus.length} owned = ${allSkus.length} unique ===\n`);

  console.log(`STRATEGY_MODE=${env.STRATEGY_MODE}\n`);

  let tradeBuys = 0;
  let tradeSells = 0;
  let listingBuys = 0;
  let listingSells = 0;
  let skipped = 0;

  const costBasisBySku = new Map(owned.map((o) => [o.skuKey, o.acquiredPriceRef]));

  for (const skuKey of allSkus) {
    const meta = parseSkuKey(skuKey);
    if (!meta) {
      skipped++;
      continue;
    }
    const owns = ownedSkus.includes(skuKey);

    // Competitive prices off the pricedb reference (the real market level).
    const ob = await getOrderBook(skuKey); // kept only for the orderbook display below
    const ref = getRefPrice(skuKey);
    const mmBuy = ref
      ? priceCompetitiveBuy({
          refBuyRef: ref.buyRef,
          refSellRef: ref.sellRef,
          maxBuyCapRef: env.WATCH_MAX_BUY_REF,
          minSpreadScrap: env.MM_MIN_SPREAD_SCRAP,
        })
      : null;
    const costBasis = costBasisBySku.get(skuKey) ?? ref?.buyRef ?? 0;
    const mmSell = owns && ref ? priceCompetitiveSell(ref.sellRef, costBasis, env.MM_MIN_SPREAD_SCRAP) : null;

    // Arbitrage-mode comparison (needs the richer snapshot).
    const market = await buildMarketSnapshot(skuKey, meta);
    const tradeDecision = market
      ? evaluate({ skuKey, name: skuKey, market: { ...market, skuKey, sellCount: 0, buyCount: 0 } })
      : null;
    const arbBuy = market ? evaluateListingBuyPrice({ skuKey, market }) : null;
    const arbSell = market && owns ? evaluateListingSellPrice({ skuKey, market }) : null;

    if (tradeDecision?.intent === 'BUY') tradeBuys++;
    if (tradeDecision?.intent === 'SELL') tradeSells++;
    if (mmBuy) listingBuys++;
    if (mmSell) listingSells++;

    console.log(
      JSON.stringify(
        {
          skuKey,
          owned: owns,
          orderbook: { highestBuy: ob.buys[0]?.priceRef ?? null, lowestSell: ob.sells[0]?.priceRef ?? null },
          marketMaking: { buy: mmBuy, sell: mmSell, costBasis },
          arbitrage: { buy: arbBuy, sell: arbSell, fairValue: market?.fairValueRef ?? null },
          tradeDecision,
        },
        null,
        2,
      ),
    );
  }

  console.log(`\n=== Summary (market_making) ===`);
  console.log(`MM listing prices: ${listingBuys} BUY / ${listingSells} SELL`);
  console.log(`Arbitrage trade decisions: ${tradeBuys} BUY / ${tradeSells} SELL`);
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
