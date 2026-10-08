/**
 * Orders: goods kept for a customer, money still owed, things to hand over.
 *
 * Only KEPT sales are orders. The four tabs a shop sees are filters over two independent facts --
 * where the goods are, and whether money is owed -- not four states an order moves between.
 */
export { list, collect, writeOff, markReady, handOver, summary, needsAttention, owedByCustomer } from './orders.service';
export type { OrderTab, OrderRow, NeedsAttention } from './orders.service';
