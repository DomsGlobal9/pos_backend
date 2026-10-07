-- Closing a day again after late bills: the revision, with earlier closes kept in by_method.
ALTER TABLE "day_closes" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
