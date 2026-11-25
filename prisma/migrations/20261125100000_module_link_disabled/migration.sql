-- The Boutique super admin switching POS off for a boutique (25 Nov).
ALTER TABLE "module_links" ADD COLUMN "disabled_at" TIMESTAMP(3);
