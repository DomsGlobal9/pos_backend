-- Marking a payment as never arrived needs a manager (or the owner).
ALTER TYPE "ApprovalKind" ADD VALUE 'PAYMENT_VOID';

-- The permission behind it, given to every shop's existing OWNER and MANAGER roles. New shops get it
-- from ensureRoles (services/shop-setup).
INSERT INTO "permissions" ("id", "key")
SELECT gen_random_uuid()::text, 'payment:void'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'payment:void');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."key" = 'payment:void'
 WHERE r."name" IN ('OWNER', 'MANAGER')
ON CONFLICT DO NOTHING;

-- Bills the owner left out of Inventory.
CREATE TABLE "inventory_skips" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "document" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "refused_code" TEXT,
    "refused_text" TEXT,
    "reason" TEXT NOT NULL,
    "skipped_by_id" TEXT,
    "skipped_by" TEXT,
    "skipped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reported_at" TIMESTAMP(3),

    CONSTRAINT "inventory_skips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_skips_client_id_sequence_key" ON "inventory_skips"("client_id", "sequence");
CREATE INDEX "inventory_skips_client_id_skipped_at_idx" ON "inventory_skips"("client_id", "skipped_at");
