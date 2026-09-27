-- AlterTable
ALTER TABLE "webhook_endpoints" DROP COLUMN "secret_hash",
ADD COLUMN     "failing_since" TIMESTAMP(3),
ADD COLUMN     "secret_cipher" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_request_once" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_request_once_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_client_id_idx" ON "api_keys"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_request_once_client_id_idempotency_key_key" ON "api_request_once"("client_id", "idempotency_key");

