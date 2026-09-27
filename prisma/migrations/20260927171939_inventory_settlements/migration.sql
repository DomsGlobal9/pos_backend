-- CreateTable
CREATE TABLE "inventory_settlements" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "reference" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "next_check_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "detail" TEXT,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "inventory_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_settlements_settled_at_next_check_at_idx" ON "inventory_settlements"("settled_at", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_settlements_client_id_sequence_key" ON "inventory_settlements"("client_id", "sequence");

