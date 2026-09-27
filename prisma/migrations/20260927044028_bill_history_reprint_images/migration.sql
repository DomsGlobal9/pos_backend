-- AlterTable
ALTER TABLE "items" ADD COLUMN     "image_url" TEXT,
ADD COLUMN     "variant_group" TEXT;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "last_printed_at" TIMESTAMP(3),
ADD COLUMN     "print_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "items_client_id_variant_group_idx" ON "items"("client_id", "variant_group");
