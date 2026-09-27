/**
 * The link to Inventory: connecting a shop, sending the outbox in order, and copying the catalogue
 * into the till's own item list. Contract: docs/product/INVENTORY-CONTRACT.md.
 */
export { connect, disconnect, setWhenDown, retry, status } from './link.service';
export { deliverNext, drain, runOnce, startDeliveryLoop, backoffFor, STOCK_EVENTS } from './delivery.service';
export { syncCatalogue } from './catalogue.service';
export type { Outcome } from './delivery.service';
