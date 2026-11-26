-- One-switch onboarding (26 Nov): the platform's client id, the modules the client has, and the last switch
-- message applied (an older one arriving late is ignored).
ALTER TABLE "shop_settings" ADD COLUMN "platform_client_id" TEXT;
ALTER TABLE "shop_settings" ADD COLUMN "platform_modules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "shop_settings" ADD COLUMN "platform_version" BIGINT;
ALTER TABLE "shop_settings" ADD COLUMN "platform_at" TIMESTAMP(3);
