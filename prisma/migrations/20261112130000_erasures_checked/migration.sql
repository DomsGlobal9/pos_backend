-- When the till last read Inventory's erasure list, and how many it has forgotten (12 Nov).
ALTER TABLE "inventory_links" ADD COLUMN "erasures_checked_at" TIMESTAMP(3);
ALTER TABLE "inventory_links" ADD COLUMN "erased_count" INTEGER NOT NULL DEFAULT 0;
