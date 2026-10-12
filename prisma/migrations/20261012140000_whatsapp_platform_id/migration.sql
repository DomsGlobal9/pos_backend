-- Bills are not sent on WhatsApp by themselves after all (12 Oct: the WhatsApp service's rule, one per
-- press, kept by the owner's decision). And the shop's id as Inventory and the WhatsApp service know it.
ALTER TABLE "shop_settings" DROP COLUMN IF EXISTS "whatsapp_auto_bill";
ALTER TABLE "inventory_links" ADD COLUMN "platform_client_id" TEXT;
