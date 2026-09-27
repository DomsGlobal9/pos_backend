-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'EXCHANGE';

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "return_id" TEXT;

-- AlterTable
ALTER TABLE "return_lines" ADD COLUMN     "cgst_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "igst_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sgst_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tax_paise" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "customer_id" TEXT,
ADD COLUMN     "round_off_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tax_paise" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "return_refunds" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "method" "RefundMethod" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_credit_entries" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "balance_after_paise" INTEGER NOT NULL,
    "return_id" TEXT,
    "sale_id" TEXT,
    "by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_refunds_return_id_idx" ON "return_refunds"("return_id");

-- CreateIndex
CREATE INDEX "return_refunds_client_id_created_at_idx" ON "return_refunds"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "store_credit_entries_customer_id_created_at_idx" ON "store_credit_entries"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "store_credit_entries_client_id_created_at_idx" ON "store_credit_entries"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "approvals_return_id_idx" ON "approvals"("return_id");

-- CreateIndex
CREATE INDEX "returns_exchange_sale_id_idx" ON "returns"("exchange_sale_id");

-- CreateIndex
CREATE INDEX "returns_customer_id_idx" ON "returns"("customer_id");

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_exchange_sale_id_fkey" FOREIGN KEY ("exchange_sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_refunds" ADD CONSTRAINT "return_refunds_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
