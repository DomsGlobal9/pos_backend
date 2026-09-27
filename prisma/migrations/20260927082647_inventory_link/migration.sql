-- CreateTable
CREATE TABLE "inventory_links" (
    "client_id" TEXT NOT NULL,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "base_url" TEXT NOT NULL,
    "key_cipher" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "when_down" TEXT NOT NULL DEFAULT 'SELL',
    "delivered_sequence" BIGINT NOT NULL DEFAULT 0,
    "last_delivered_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "locked_until" TIMESTAMP(3),
    "blocked_sequence" BIGINT,
    "blocked_code" TEXT,
    "blocked_message" TEXT,
    "catalogue_cursor" TEXT,
    "catalogue_synced_at" TIMESTAMP(3),
    "catalogue_problems" JSONB,
    "connected_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_links_pkey" PRIMARY KEY ("client_id")
);
