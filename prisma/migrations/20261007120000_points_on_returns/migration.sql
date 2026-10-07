-- Contract §10.5: points spent come back as points, so a return refunds only the money share.
ALTER TABLE "payments" ADD COLUMN "points" INTEGER;
ALTER TABLE "returns" ADD COLUMN "points_back" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "returns" ADD COLUMN "points_back_paise" INTEGER NOT NULL DEFAULT 0;
