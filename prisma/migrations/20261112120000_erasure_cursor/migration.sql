-- Where the till left off in Inventory's list of erased customers (12 Nov).
ALTER TABLE "inventory_links" ADD COLUMN "erasure_cursor" TEXT;
