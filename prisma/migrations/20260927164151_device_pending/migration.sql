-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "pending_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pending_oldest_at" TIMESTAMP(3);

