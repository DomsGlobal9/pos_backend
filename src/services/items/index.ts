/**
 * Items: finding something to sell, and reading the prices a sale is actually written from.
 *
 * Standalone mode reads the POS's own Item table. With Inventory behind it the same shape comes
 * from the cache, refreshed through the Gateway -- the screen cannot tell the difference.
 */
export { search, forSale } from './items.service';
export type { FoundItem, SearchResult } from './items.service';
