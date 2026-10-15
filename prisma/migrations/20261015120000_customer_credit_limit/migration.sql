-- How much a customer may owe before a cashier needs a manager (15 Oct). Null: always a manager.
ALTER TABLE "customers" ADD COLUMN "credit_limit_paise" INTEGER;
