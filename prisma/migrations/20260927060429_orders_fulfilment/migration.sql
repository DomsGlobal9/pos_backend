-- CreateEnum
CREATE TYPE "Fulfilment" AS ENUM ('WAITING', 'READY', 'HANDED_OVER');

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "fulfilment" "Fulfilment" NOT NULL DEFAULT 'HANDED_OVER',
ADD COLUMN     "handed_over_at" TIMESTAMP(3),
ADD COLUMN     "handed_over_by_id" TEXT,
ADD COLUMN     "handover_due_paise" INTEGER,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "promised_at" TIMESTAMP(3),
ADD COLUMN     "ready_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "sales_client_id_kind_fulfilment_idx" ON "sales"("client_id", "kind", "fulfilment");
