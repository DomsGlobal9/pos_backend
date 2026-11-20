-- Another ScaleEzy module billing through POS (20 Nov): the Boutique app's retail counter.
ALTER TABLE "users" ADD COLUMN "external_ref" TEXT;
CREATE UNIQUE INDEX "users_client_id_external_ref_key" ON "users"("client_id", "external_ref");

CREATE TABLE "module_links" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "scopes" TEXT[],
    "counter_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "last_call_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "module_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "module_links_client_id_module_key" ON "module_links"("client_id", "module");
CREATE UNIQUE INDEX "module_links_module_tenant_key" ON "module_links"("module", "tenant");
ALTER TABLE "module_links" ADD CONSTRAINT "module_links_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "counters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
