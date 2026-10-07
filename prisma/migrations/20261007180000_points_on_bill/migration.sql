-- Loyalty points on the bill, as Inventory settled it (contract §10).
ALTER TABLE "sales" ADD COLUMN "points_earned" INTEGER;
ALTER TABLE "sales" ADD COLUMN "points_used" INTEGER;
ALTER TABLE "sales" ADD COLUMN "points_balance_after" INTEGER;
