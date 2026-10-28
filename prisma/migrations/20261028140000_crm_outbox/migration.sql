-- What the till tells ScaleEzy CRM (28 Oct): customers made or changed at the counter, and consent ticked there.
CREATE TABLE "crm_outbox" (
  "id"              TEXT NOT NULL,
  "client_id"       TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "payload"         JSONB NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "occurred_at"     TIMESTAMP(3) NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at"         TIMESTAMP(3),
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "last_error"      TEXT,
  "set_aside"       BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "crm_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "crm_outbox_client_id_idempotency_key_key" ON "crm_outbox"("client_id", "idempotency_key");
CREATE INDEX "crm_outbox_client_id_sent_at_set_aside_created_at_idx" ON "crm_outbox"("client_id", "sent_at", "set_aside", "created_at");
