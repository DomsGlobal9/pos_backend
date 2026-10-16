-- Gift vouchers (16 Oct; Inventory holds every balance, PLAN-gift-vouchers.md).
-- A bill paid by voucher, and a return put back onto one.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'VOUCHER';
ALTER TYPE "RefundMethod" ADD VALUE IF NOT EXISTS 'VOUCHER';

-- The till's own record of each voucher it SOLD: the money is in its drawer (shift and day close).
CREATE TABLE "voucher_sales" (
  "id"           TEXT NOT NULL,
  "client_id"    TEXT NOT NULL,
  "code"         TEXT NOT NULL,
  "amount_paise" INTEGER NOT NULL,
  "cash_paise"   INTEGER NOT NULL DEFAULT 0,
  "payments"     JSONB NOT NULL,
  "expires_at"   TIMESTAMP(3) NOT NULL,
  "buyer_name"   TEXT,
  "buyer_phone"  TEXT,
  "counter_id"   TEXT,
  "shift_id"     TEXT,
  "sold_by_id"   TEXT,
  "once_key"     TEXT NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voucher_sales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voucher_sales_client_id_once_key_key" ON "voucher_sales"("client_id", "once_key");
CREATE INDEX "voucher_sales_client_id_created_at_idx" ON "voucher_sales"("client_id", "created_at");
CREATE INDEX "voucher_sales_shift_id_idx" ON "voucher_sales"("shift_id");
