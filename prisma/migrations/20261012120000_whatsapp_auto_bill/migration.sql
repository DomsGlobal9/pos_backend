-- The bill sent on WhatsApp by itself after each sale with a customer (12 Oct). Off until the owner
-- switches it on; sent from the number the shop linked in Inventory.
ALTER TABLE "shop_settings" ADD COLUMN "whatsapp_auto_bill" BOOLEAN NOT NULL DEFAULT false;
