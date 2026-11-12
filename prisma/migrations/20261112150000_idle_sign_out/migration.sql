-- How long the till waits with nothing happening before asking for a PIN again (12 Nov). 0 = never.
ALTER TABLE "shop_settings" ADD COLUMN "idle_sign_out_minutes" INTEGER NOT NULL DEFAULT 10;
