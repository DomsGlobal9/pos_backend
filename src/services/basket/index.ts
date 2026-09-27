/**
 * Basket: what a basket comes to, as pure arithmetic.
 *
 * Callers import this folder, never the files inside it. When the shared offers package arrives it
 * slots in beside this rather than replacing it -- offers decide what comes off, this decides what
 * the bill then is.
 */
export { priceBasket } from './basket.service';
export type { BasketLine, PricedLine, PricedBasket, PriceBasketOptions } from './basket.service';
