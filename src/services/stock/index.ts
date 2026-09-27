/**
 * The POS's own count of pieces left: advisory, never blocking, moved by sales and returns in the
 * same transaction as the bill. See stock.service.
 */
export { adjust, sold, cameBack } from './stock.service';
export type { StockChange } from './stock.service';
