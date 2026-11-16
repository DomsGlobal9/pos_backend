-- Selling by the metre (16 Nov): how an item is sold, its factor and smallest cut; a bill line keeps its unit.
ALTER TABLE "items" ADD COLUMN "sold_by" TEXT NOT NULL DEFAULT 'PIECE';
ALTER TABLE "items" ADD COLUMN "unit_factor" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "items" ADD COLUMN "min_cut" INTEGER;
ALTER TABLE "sale_lines" ADD COLUMN "sold_by" TEXT NOT NULL DEFAULT 'PIECE';
ALTER TABLE "sale_lines" ADD COLUMN "unit_factor" INTEGER NOT NULL DEFAULT 1;
