-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SeriesKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "SaleKind" AS ENUM ('COMPLETE', 'KEPT');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'BALANCE_DUE', 'RETURNED', 'PENDING_SYNC');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'CREDIT', 'POINTS', 'BALANCE');

-- CreateEnum
CREATE TYPE "RefundMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'STORE_CREDIT', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "password_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "client_id" TEXT,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "shop_settings" (
    "client_id" TEXT NOT NULL,
    "shop_name" TEXT NOT NULL,
    "gstin" TEXT,
    "address" TEXT,
    "logo_url" TEXT,
    "receipt_footer" TEXT,
    "invoice_prefix" TEXT NOT NULL DEFAULT 'INV',
    "credit_note_prefix" TEXT NOT NULL DEFAULT 'CN',
    "enabled_payment_methods" "PaymentMethod"[],
    "manual_discount_max_percent" INTEGER NOT NULL DEFAULT 0,
    "return_window_days" INTEGER NOT NULL DEFAULT 7,
    "hold_threshold_qty" INTEGER NOT NULL DEFAULT 3,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "counters" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_series" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "kind" "SeriesKind" NOT NULL,
    "prefix" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "gstin" TEXT,
    "loyalty_points" INTEGER NOT NULL DEFAULT 0,
    "store_credit_paise" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "colour" TEXT,
    "size" TEXT,
    "hsn" TEXT,
    "price_paise" INTEGER NOT NULL,
    "tax_rate" INTEGER NOT NULL DEFAULT 0,
    "inventory_variant_id" TEXT,
    "cached_qty" INTEGER,
    "cached_qty_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "counter_id" TEXT NOT NULL,
    "cashier_id" TEXT,
    "kind" "SaleKind" NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "customer_id" TEXT,
    "subtotal_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "tax_paise" INTEGER NOT NULL DEFAULT 0,
    "round_off_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL,
    "saved_paise" INTEGER NOT NULL DEFAULT 0,
    "once_key" TEXT NOT NULL,
    "hold_id" TEXT,
    "hold_confirmed_at" TIMESTAMP(3),
    "irn" TEXT,
    "ack_no" TEXT,
    "signed_qr" TEXT,
    "made_offline_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_lines" (
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "item_id" TEXT,
    "inventory_variant_id" TEXT,
    "description" TEXT NOT NULL,
    "hsn" TEXT,
    "qty" INTEGER NOT NULL,
    "unit_price_paise" INTEGER NOT NULL,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "tax_rate" INTEGER NOT NULL DEFAULT 0,
    "tax_paise" INTEGER NOT NULL DEFAULT 0,
    "line_total_paise" INTEGER NOT NULL,
    "applied_offers" JSONB,
    "price_override_reason" TEXT,

    CONSTRAINT "sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reference" TEXT,
    "tendered_paise" INTEGER,
    "change_paise" INTEGER,
    "once_key" TEXT NOT NULL,
    "collected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "returns" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "credit_note_no" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "original_sale_id" TEXT NOT NULL,
    "cashier_id" TEXT,
    "reason" TEXT NOT NULL,
    "refund_method" "RefundMethod" NOT NULL,
    "total_paise" INTEGER NOT NULL,
    "exchange_sale_id" TEXT,
    "once_key" TEXT NOT NULL,
    "hold_id" TEXT,
    "hold_confirmed_at" TIMESTAMP(3),
    "approved_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_lines" (
    "id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "sale_line_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,

    CONSTRAINT "return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "held_bills" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "counter_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "held_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "counter_id" TEXT NOT NULL,
    "cashier_id" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_cash_paise" INTEGER NOT NULL,
    "closed_at" TIMESTAMP(3),
    "expected_cash_paise" INTEGER,
    "counted_cash_paise" INTEGER,
    "difference_paise" INTEGER,
    "closing_note" TEXT,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "day_closes" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sales_count" INTEGER NOT NULL DEFAULT 0,
    "gross_paise" INTEGER NOT NULL DEFAULT 0,
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "tax_paise" INTEGER NOT NULL DEFAULT 0,
    "net_paise" INTEGER NOT NULL DEFAULT 0,
    "returns_paise" INTEGER NOT NULL DEFAULT 0,
    "cash_position_paise" INTEGER NOT NULL DEFAULT 0,
    "by_method" JSONB NOT NULL,
    "closed_by_id" TEXT,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "secret_prefix" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_delivery_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "client_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "invoice_no" TEXT,
    "item_code" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "response_code" INTEGER,
    "response_body" TEXT,
    "locked_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "subject" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_client_id_idx" ON "users"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_client_id_email_key" ON "users"("client_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_client_id_name_key" ON "roles"("client_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "counters_client_id_idx" ON "counters"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "counters_client_id_name_key" ON "counters"("client_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_series_client_id_financial_year_kind_key" ON "invoice_series"("client_id", "financial_year", "kind");

-- CreateIndex
CREATE INDEX "customers_client_id_idx" ON "customers"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_client_id_phone_key" ON "customers"("client_id", "phone");

-- CreateIndex
CREATE INDEX "items_client_id_idx" ON "items"("client_id");

-- CreateIndex
CREATE INDEX "items_client_id_inventory_variant_id_idx" ON "items"("client_id", "inventory_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "items_client_id_code_key" ON "items"("client_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "items_client_id_barcode_key" ON "items"("client_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "sales_once_key_key" ON "sales"("once_key");

-- CreateIndex
CREATE INDEX "sales_client_id_created_at_idx" ON "sales"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "sales_client_id_status_idx" ON "sales"("client_id", "status");

-- CreateIndex
CREATE INDEX "sales_counter_id_idx" ON "sales"("counter_id");

-- CreateIndex
CREATE INDEX "sales_customer_id_idx" ON "sales"("customer_id");

-- CreateIndex
CREATE INDEX "sales_hold_id_idx" ON "sales"("hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_client_id_invoice_no_key" ON "sales"("client_id", "invoice_no");

-- CreateIndex
CREATE INDEX "sale_lines_sale_id_idx" ON "sale_lines"("sale_id");

-- CreateIndex
CREATE INDEX "sale_lines_item_id_idx" ON "sale_lines"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_once_key_key" ON "payments"("once_key");

-- CreateIndex
CREATE INDEX "payments_client_id_created_at_idx" ON "payments"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_sale_id_idx" ON "payments"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "returns_once_key_key" ON "returns"("once_key");

-- CreateIndex
CREATE INDEX "returns_client_id_created_at_idx" ON "returns"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "returns_original_sale_id_idx" ON "returns"("original_sale_id");

-- CreateIndex
CREATE INDEX "returns_hold_id_idx" ON "returns"("hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "returns_client_id_credit_note_no_key" ON "returns"("client_id", "credit_note_no");

-- CreateIndex
CREATE INDEX "return_lines_return_id_idx" ON "return_lines"("return_id");

-- CreateIndex
CREATE INDEX "return_lines_sale_line_id_idx" ON "return_lines"("sale_line_id");

-- CreateIndex
CREATE INDEX "held_bills_client_id_counter_id_idx" ON "held_bills"("client_id", "counter_id");

-- CreateIndex
CREATE INDEX "shifts_client_id_opened_at_idx" ON "shifts"("client_id", "opened_at");

-- CreateIndex
CREATE INDEX "shifts_counter_id_closed_at_idx" ON "shifts"("counter_id", "closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "day_closes_client_id_date_key" ON "day_closes"("client_id", "date");

-- CreateIndex
CREATE INDEX "webhook_endpoints_client_id_idx" ON "webhook_endpoints"("client_id");

-- CreateIndex
CREATE INDEX "webhook_events_client_id_sequence_idx" ON "webhook_events"("client_id", "sequence");

-- CreateIndex
CREATE INDEX "webhook_events_event_type_idx" ON "webhook_events"("event_type");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_client_id_status_idx" ON "webhook_deliveries"("client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_event_id_endpoint_id_key" ON "webhook_deliveries"("event_id", "endpoint_id");

-- CreateIndex
CREATE INDEX "audit_logs_client_id_created_at_idx" ON "audit_logs"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "counters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_original_sale_id_fkey" FOREIGN KEY ("original_sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_sale_line_id_fkey" FOREIGN KEY ("sale_line_id") REFERENCES "sale_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_bills" ADD CONSTRAINT "held_bills_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "counters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "counters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "webhook_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
