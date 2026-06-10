/**
 * One-off: register user-deposited Steam items in the bot's ledger so the sell
 * loop can list them. Creates the Item (by skuKey) and an InventoryItem in HELD
 * with cost basis = current pricedb buy (fair market cost at import; null price
 * → 0). Idempotent: an assetId already in the ledger is skipped.
 *
 * Edit ITEMS below, then run with DATABASE_URL set:
 *   pnpm --filter @bptf/bot exec tsx src/scripts/importHeldItems.ts
 *
 * Deliberately does NOT import @bptf/* runtime modules that need the full bot
 * env (Steam creds etc.) — only Prisma + the public pricedb endpoint.
 */
import { PrismaClient } from '@bptf/db';
import axios from 'axios';

interface DepositedItem {
  assetId: string;
  skuKey: string;
  name: string;
}

// The user's 2026-06-10 deposit (from the live Steam inventory snapshot).
const ITEMS: DepositedItem[] = [
  { assetId: '16986820223', skuKey: '725;6', name: 'Tour of Duty Ticket' },
  { assetId: '17103676143', skuKey: '5976;6;c150', name: 'Winter 2025 Cosmetic Case' },
  { assetId: '17124298378', skuKey: '5976;6;c150', name: 'Winter 2025 Cosmetic Case' },
  { assetId: '17094789457', skuKey: '5976;6;c150', name: 'Winter 2025 Cosmetic Case' },
];

const prisma = new PrismaClient();

function parseSku(sku: string): { defindex: number; quality: number; craftable: boolean } {
  const parts = sku.split(';');
  return { defindex: Number(parts[0]), quality: Number(parts[1] ?? 6), craftable: !parts.includes('uncraftable') };
}

async function pricedbBuyRef(sku: string): Promise<number> {
  try {
    const resp = await axios.get(`https://pricedb.io/api/item/${encodeURIComponent(sku)}`, {
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (resp.status !== 200) return 0;
    const buy = (resp.data as { buy?: { keys?: number; metal?: number } }).buy;
    // Keys folded at 0 — none of the deposited items are key-priced; metal only.
    return buy?.metal ?? 0;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  for (const it of ITEMS) {
    const existing = await prisma.inventoryItem.findUnique({ where: { assetId: it.assetId } });
    if (existing) {
      console.log(`skip ${it.assetId} (${it.name}) — already in ledger (${existing.status})`);
      continue;
    }
    const meta = parseSku(it.skuKey);
    const item = await prisma.item.upsert({
      where: { skuKey: it.skuKey },
      create: { skuKey: it.skuKey, name: it.name, defindex: meta.defindex, quality: meta.quality, craftable: meta.craftable },
      update: {},
      select: { id: true },
    });
    const costRef = await pricedbBuyRef(it.skuKey);
    await prisma.inventoryItem.create({
      data: { assetId: it.assetId, itemId: item.id, acquiredPriceRef: costRef, status: 'HELD' },
    });
    console.log(`HELD ${it.assetId} ${it.skuKey} (${it.name}) cost=${costRef} ref`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
