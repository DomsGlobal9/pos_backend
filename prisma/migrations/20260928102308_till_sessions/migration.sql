-- CreateTable
CREATE TABLE "till_sessions" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "opened_by_id" TEXT NOT NULL,
    "device_id" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "closed_by_id" TEXT,

    CONSTRAINT "till_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "till_sessions_client_id_idx" ON "till_sessions"("client_id");

