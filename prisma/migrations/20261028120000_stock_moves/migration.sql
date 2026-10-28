-- Standalone stock (28 Oct): received / adjusted / counted, with who and why; and the shop's low-stock level.
ALTER TABLE "shop_settings" ADD COLUMN IF NOT EXISTS "low_stock_at" INTEGER NOT NULL DEFAULT 2;

CREATE TABLE "stock_moves" (
  "id"         TEXT NOT NULL,
  "client_id"  TEXT NOT NULL,
  "item_id"    TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "delta"      INTEGER NOT NULL,
  "qty_before" INTEGER,
  "qty_after"  INTEGER NOT NULL,
  "reason"     TEXT,
  "note"       TEXT,
  "by_id"      TEXT,
  "by_name"    TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_moves_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stock_moves_client_id_item_id_created_at_idx" ON "stock_moves"("client_id", "item_id", "created_at");
CREATE INDEX "stock_moves_client_id_created_at_idx" ON "stock_moves"("client_id", "created_at");
