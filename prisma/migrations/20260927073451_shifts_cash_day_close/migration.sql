-- CreateEnum
CREATE TYPE "CashDirection" AS ENUM ('IN', 'OUT');

-- AlterEnum
ALTER TYPE "ApprovalKind" ADD VALUE 'CASH_OUT';

-- AlterTable
ALTER TABLE "day_closes" ADD COLUMN     "cash_in_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cash_out_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "counted_cash_paise" INTEGER,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "open_shifts_at_close" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "opening_cash_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payments_to_check" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "returns_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unattributed_cash_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "variance_paise" INTEGER;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "shift_id" TEXT;

-- AlterTable
ALTER TABLE "return_refunds" ADD COLUMN     "shift_id" TEXT;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "shift_id" TEXT;

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "closed_by_id" TEXT;

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "direction" "CashDirection" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "by_id" TEXT,
    "approved_by_id" TEXT,
    "once_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_movements_once_key_key" ON "cash_movements"("once_key");

-- CreateIndex
CREATE INDEX "cash_movements_shift_id_idx" ON "cash_movements"("shift_id");

-- CreateIndex
CREATE INDEX "cash_movements_client_id_created_at_idx" ON "cash_movements"("client_id", "created_at");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_refunds" ADD CONSTRAINT "return_refunds_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ONE OPEN SHIFT PER COUNTER, held by the database. Two cashiers pressing "Open shift" on the same
-- counter at the same moment must not produce two drawers that each think they own the cash. The
-- service checks first and says so in words; this is what makes the check true under a race.
CREATE UNIQUE INDEX "shifts_one_open_per_counter" ON "shifts" ("counter_id") WHERE "closed_at" IS NULL;

-- Amounts that can only ever be positive.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_amount_positive" CHECK ("amount_paise" > 0);
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_opening_cash_not_negative" CHECK ("opening_cash_paise" >= 0);
