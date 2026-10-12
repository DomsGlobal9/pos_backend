-- WhatsApp service events already handled (12 Oct): each arrives at least once; a repeat does nothing.
CREATE TABLE "whatsapp_events_seen" (
    "id" TEXT NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_events_seen_pkey" PRIMARY KEY ("id")
);
