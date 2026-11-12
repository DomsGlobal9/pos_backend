-- What Inventory pushes to the till (12 Nov, PLAN-live step 3).
CREATE TABLE "inventory_inbound" (
    "id" TEXT NOT NULL,
    "inventory_shop" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "outcome" TEXT,
    CONSTRAINT "inventory_inbound_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_inbound_inventory_shop_event_id_key" ON "inventory_inbound"("inventory_shop", "event_id");
CREATE INDEX "inventory_inbound_processed_at_idx" ON "inventory_inbound"("processed_at");
