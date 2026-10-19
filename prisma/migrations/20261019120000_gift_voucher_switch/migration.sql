-- The shop's gift voucher switch and limits, as Inventory's catalogue carries them (19 Oct). Null: not said yet.
ALTER TABLE "shop_settings" ADD COLUMN "gift_vouchers" JSONB;
