-- Whether cut cloth may come back, from Inventory (16 Nov). Null: not said.
ALTER TABLE "items" ADD COLUMN "cut_returnable" BOOLEAN;
