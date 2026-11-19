-- ScaleEzy CRM owns who a customer is (owner, 19 Nov). Nothing here runs until CRM is set up for a shop.

-- A customer joined into another by a CRM merge.
ALTER TABLE "customers" ADD COLUMN "merged_into_id" TEXT;

-- The till's link to CRM's customer, and the link job's bookkeeping.
CREATE TABLE "crm_customer_links" (
    "customer_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "crm_customer_id" TEXT,
    "linked_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_try_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_problem" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_customer_links_pkey" PRIMARY KEY ("customer_id")
);
CREATE INDEX "crm_customer_links_client_id_crm_customer_id_idx" ON "crm_customer_links"("client_id", "crm_customer_id");
CREATE INDEX "crm_customer_links_client_id_next_try_at_idx" ON "crm_customer_links"("client_id", "next_try_at");
ALTER TABLE "crm_customer_links" ADD CONSTRAINT "crm_customer_links_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CRM's events already applied.
CREATE TABLE "crm_inbound_events" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_inbound_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "crm_inbound_events_client_id_received_at_idx" ON "crm_inbound_events"("client_id", "received_at");

-- What each merge moved, for its undo.
CREATE TABLE "crm_customer_merges" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "from_crm_id" TEXT NOT NULL,
    "into_crm_id" TEXT NOT NULL,
    "dropped_customer_id" TEXT,
    "kept_customer_id" TEXT,
    "moved" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMP(3),
    CONSTRAINT "crm_customer_merges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "crm_customer_merges_client_id_from_crm_id_idx" ON "crm_customer_merges"("client_id", "from_crm_id");
