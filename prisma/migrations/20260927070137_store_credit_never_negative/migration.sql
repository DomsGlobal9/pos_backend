-- Store credit can never go below zero. The service already refuses an overdraw with a guarded
-- UPDATE; this is the same rule held by the database, so a future code path that forgets the guard
-- fails loudly instead of letting the shop's own money out of the door twice. CONTRACTS 1.1.
ALTER TABLE "customers" ADD CONSTRAINT "customers_store_credit_not_negative" CHECK ("store_credit_paise" >= 0);
ALTER TABLE "customers" ADD CONSTRAINT "customers_loyalty_points_not_negative" CHECK ("loyalty_points" >= 0);
