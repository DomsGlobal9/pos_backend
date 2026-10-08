-- Who served the customer, for incentives: picked from the staff, frozen on the bill at issue.
ALTER TABLE "sales" ADD COLUMN "salesperson_id" TEXT;
ALTER TABLE "sales" ADD COLUMN "salesperson_name" TEXT;
