-- The return window can be "no limit" (empty): Inventory's rule, which the till now follows
-- (catalogue `returns.windowDays`, 9 Oct). A shop without Inventory keeps its 7 days.
ALTER TABLE "shop_settings" ALTER COLUMN "return_window_days" DROP NOT NULL;
