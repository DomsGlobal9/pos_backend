-- What a bill IS under GST, by the shop's registration: tax invoice, Bill of Supply, or receipt.
ALTER TABLE "shop_settings" ADD COLUMN "gst_registration" TEXT NOT NULL DEFAULT 'REGULAR';
ALTER TABLE "sales" ADD COLUMN "document_kind" TEXT NOT NULL DEFAULT 'TAX_INVOICE';
