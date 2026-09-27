-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "consent_at" TIMESTAMP(3),
ADD COLUMN     "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT;

-- CreateIndex
CREATE INDEX "customers_client_id_name_idx" ON "customers"("client_id", "name");
