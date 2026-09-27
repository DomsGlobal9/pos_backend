-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('DISCOUNT_OVER_LIMIT', 'PRICE_OVERRIDE', 'RETURN', 'RETURN_OUTSIDE_WINDOW');

-- AlterTable
ALTER TABLE "sale_lines" ADD COLUMN     "list_price_paise" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "approval_pin_hash" TEXT;

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "kind" "ApprovalKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" JSONB,
    "requested_by_id" TEXT,
    "approved_by_id" TEXT NOT NULL,
    "sale_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approvals_client_id_created_at_idx" ON "approvals"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "approvals_sale_id_idx" ON "approvals"("sale_id");

-- CreateIndex
CREATE INDEX "approvals_approved_by_id_idx" ON "approvals"("approved_by_id");

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;
