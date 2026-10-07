-- Self-confirming UPI (PLAN-payments Step 2): the shop's switch, and the QR a payment was paid to.
ALTER TABLE "shop_settings" ADD COLUMN "upi_qr_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payments" ADD COLUMN "qr_id" TEXT;
CREATE INDEX "payments_qr_waiting_idx" ON "payments" ("client_id") WHERE "qr_id" IS NOT NULL AND "status" = 'NEEDS_CHECKING';
