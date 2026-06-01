import { prisma } from '../integrations/db.js';

// Ownership service for SELL listings. Source of truth is InventoryItem
// (HELD/LISTED/RESERVED/SOLD), joined to Item for the skuKey.

export interface OwnedItem {
  skuKey: string;
  itemId: string; // Item.id
  inventoryItemId: string; // InventoryItem.id
  assetId: string;
  acquiredPriceRef: number;
}

/**
 * Items the bot owns and can list for sale: InventoryItem rows in HELD status,
 * joined to Item for the skuKey. Excludes RESERVED, LISTED (already on bp.tf),
 * and SOLD.
 */
export async function getOwnedListableItems(): Promise<OwnedItem[]> {
  const items = await prisma.inventoryItem.findMany({
    where: { status: 'HELD' },
    include: { item: { select: { id: true, skuKey: true } } },
  });
  return items.map((inv) => ({
    skuKey: inv.item.skuKey,
    itemId: inv.item.id,
    inventoryItemId: inv.id,
    assetId: inv.assetId,
    acquiredPriceRef: inv.acquiredPriceRef,
  }));
}

/**
 * Mark an inventory item LISTED after a sell listing is created. `reservedFor`
 * stores the Listing.id so we can release it again when the listing closes.
 */
export async function markListed(inventoryItemId: string, listingId: string): Promise<void> {
  await prisma.inventoryItem.update({
    where: { id: inventoryItemId },
    data: { status: 'LISTED', reservedFor: listingId },
  });
}

/**
 * Release an item back to HELD when its sell listing is deleted/expired without
 * a completed trade.
 */
export async function releaseToHeld(inventoryItemId: string): Promise<void> {
  await prisma.inventoryItem.update({
    where: { id: inventoryItemId },
    data: { status: 'HELD', reservedFor: null },
  });
}
