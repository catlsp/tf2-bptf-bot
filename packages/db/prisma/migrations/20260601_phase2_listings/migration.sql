-- Phase 2: track our own bp.tf listings
CREATE TABLE "OurListing" (
  "id"            TEXT PRIMARY KEY,
  "bptfListingId" TEXT UNIQUE,           -- ID from bp.tf API (null while pending)
  "skuKey"        TEXT NOT NULL,
  "intent"        TEXT NOT NULL,         -- 'buy' for Phase 2
  "priceRef"      DECIMAL(10,2) NOT NULL,
  "priceKeys"     INT NOT NULL DEFAULT 0,
  "priceMetal"    DECIMAL(10,2) NOT NULL,
  "fairValueRef"  DECIMAL(10,2) NOT NULL,
  "details"       TEXT,
  "status"        TEXT NOT NULL,         -- 'creating' | 'active' | 'deleting' | 'deleted' | 'failed'
  "errorMessage"  TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "refreshedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deletedAt"     TIMESTAMPTZ
);

CREATE INDEX "OurListing_skuKey_intent_status_idx" ON "OurListing"("skuKey", "intent", "status");
CREATE INDEX "OurListing_status_refreshedAt_idx" ON "OurListing"("status", "refreshedAt");
