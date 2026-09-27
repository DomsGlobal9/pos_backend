-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "receipt_token" TEXT;

-- AlterTable
ALTER TABLE "shop_settings" ADD COLUMN     "upi_id" TEXT;

-- CreateTable
CREATE TABLE "receipt_sends" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "to_last4" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_id" TEXT,
    "fail_reason" TEXT,
    "by_id" TEXT,
    "once_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "counter_id" TEXT,
    "app_version" TEXT,
    "user_agent" TEXT,
    "capabilities" JSONB,
    "paper_width_mm" INTEGER NOT NULL DEFAULT 80,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_user_name" TEXT,
    "last_printed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipt_sends_once_key_key" ON "receipt_sends"("once_key");

-- CreateIndex
CREATE INDEX "receipt_sends_sale_id_idx" ON "receipt_sends"("sale_id");

-- CreateIndex
CREATE INDEX "receipt_sends_client_id_created_at_idx" ON "receipt_sends"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "devices_client_id_last_seen_at_idx" ON "devices"("client_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_receipt_token_key" ON "sales"("receipt_token");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "counters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

