/**
 * The link to Inventory: connecting a shop, sending the outbox in order, and copying the catalogue
 * into the till's own item list. Contract: docs/product/INVENTORY-CONTRACT.md.
 */
export { connect, disconnect, setWhenDown, retry, status, leaveOut, SKIP_REASON_MIN } from './link.service';
export { deliverNext, drain, runOnce, checkSettlements, startDeliveryLoop, backoffFor, STOCK_EVENTS } from './delivery.service';
export { syncCatalogue, startCatalogueLoop } from './catalogue.service';
export { toInventory, readAnswer } from './wire';
export type { Outcome } from './delivery.service';
