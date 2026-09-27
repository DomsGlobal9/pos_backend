-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('COLLECTED', 'NEEDS_CHECKING', 'VOID');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "checked_at" TIMESTAMP(3),
ADD COLUMN     "checked_by_id" TEXT,
ADD COLUMN     "checked_note" TEXT,
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'COLLECTED',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "payments_client_id_status_idx" ON "payments"("client_id", "status");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_checked_by_id_fkey" FOREIGN KEY ("checked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
