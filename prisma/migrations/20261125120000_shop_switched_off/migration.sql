-- POS switched off for a shop by ScaleEzy (25 Nov).
ALTER TABLE "shop_settings" ADD COLUMN "switched_off_at" TIMESTAMP(3);
ALTER TABLE "shop_settings" ADD COLUMN "switched_off_by" TEXT;
