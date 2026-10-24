-- Card machines the till sends the amount to (24 Oct): Pine Labs Cloud, Razorpay POS.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "card_request_id" TEXT;

CREATE TABLE "card_machines" (
  "id"            TEXT NOT NULL,
  "client_id"     TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "provider"      TEXT NOT NULL,
  "test_mode"     BOOLEAN NOT NULL DEFAULT true,
  "config_cipher" TEXT NOT NULL,
  "label"         TEXT,
  "counter_id"    TEXT,
  "active"        BOOLEAN NOT NULL DEFAULT true,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "card_machines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "card_machines_client_id_idx" ON "card_machines"("client_id");

CREATE TABLE "card_requests" (
  "id"            TEXT NOT NULL,
  "client_id"     TEXT NOT NULL,
  "machine_id"    TEXT NOT NULL,
  "amount_paise"  INTEGER NOT NULL,
  "provider_ref"  TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'WAITING',
  "last4"         TEXT,
  "approval_code" TEXT,
  "rrn"           TEXT,
  "detail"        TEXT,
  "once_key"      TEXT NOT NULL,
  "created_by_id" TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "card_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "card_requests_client_id_once_key_key" ON "card_requests"("client_id", "once_key");
CREATE INDEX "card_requests_client_id_status_idx" ON "card_requests"("client_id", "status");
