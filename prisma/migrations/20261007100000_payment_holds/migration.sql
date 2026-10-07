-- Contract §10: points and store credit held in Inventory, confirmed by the till's own call.
ALTER TABLE "payments" ADD COLUMN "hold_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "hold_confirmed_at" TIMESTAMP(3);
ALTER TABLE "payments" ADD COLUMN "hold_note" TEXT;
CREATE INDEX "payments_hold_id_idx" ON "payments"("hold_id");
