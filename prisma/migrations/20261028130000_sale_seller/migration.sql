-- The seller as printed on each bill, frozen when issued (28 Oct). Older bills: null.
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "seller" JSONB;
