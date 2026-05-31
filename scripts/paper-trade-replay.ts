import { prisma } from '@bptf/db';
import { evaluate } from '../apps/bot/src/pricing/strategy.js';

// Replays historical PriceSnapshot rows through the current strategy so you can
// sanity-check decisions offline. This is a Phase 8 seam; Phase 1 ships it as a
// runnable skeleton (tsx scripts/paper-trade-replay.ts) once snapshots exist.

async function main(): Promise<void> {
  const snapshots = await prisma.priceSnapshot.findMany({
    include: { item: true },
    orderBy: { capturedAt: 'asc' },
    take: 1000,
  });

  let hits = 0;
  for (const s of snapshots) {
    const fv = ((s.buyRef ?? 0) + (s.sellRef ?? 0)) / 2;
    if (fv <= 0) continue;
    const decision = evaluate({
      skuKey: s.item.skuKey,
      name: s.item.name,
      market: {
        skuKey: s.item.skuKey,
        fairValueRef: fv,
        lowestSellRef: s.sellRef,
        highestBuyRef: s.buyRef,
        sellCount: 1,
        buyCount: 1,
      },
    });
    if (decision) {
      hits++;
      // eslint-disable-next-line no-console
      console.log(`${s.capturedAt.toISOString()} ${decision.intent} ${decision.name} +${decision.expectedProfitRef} ref`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nreplayed ${snapshots.length} snapshots, ${hits} decisions`);
  await prisma.$disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
