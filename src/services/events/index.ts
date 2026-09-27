/**
 * The outbox: one event per sale, return and exchange, written in the bill's own transaction.
 * Delivery (Inventory, a shop's own software) reads it afterwards and never blocks the till.
 */
export { saleCompleted, saleReturned, saleExchanged, dayClosed, EVENT_VERSION } from './events.service';
export type { EventType } from './events.service';
