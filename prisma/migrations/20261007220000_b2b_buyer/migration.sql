-- A tax invoice to a registered business: the buyer's name, address and GSTIN, frozen on the bill.
ALTER TABLE "customers" ADD COLUMN "address" TEXT;
ALTER TABLE "sales" ADD COLUMN "buyer_name" TEXT;
ALTER TABLE "sales" ADD COLUMN "buyer_gstin" TEXT;
ALTER TABLE "sales" ADD COLUMN "buyer_address" TEXT;
