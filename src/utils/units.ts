/**
 * SELLING BY LENGTH OR WEIGHT (16 Nov; Inventory's PLAN-fabrics, handout POS-Till-Sell-By-Metre.md).
 *
 * A measured item's quantity is held in whole BASE units -- centimetres for a metre, grams for a
 * kilogram -- and its price is per base unit, so a line is qty x price exactly as for pieces and no
 * money is ever fractional. Only what people read is in metres: "2.25 m x Rs 450 / m".
 */
export const UNITS: Record<string, { short: string; base: string }> = {
  METRE: { short: 'm', base: 'cm' },
  KILOGRAM: { short: 'kg', base: 'g' }
};

export const isMeasured = (soldBy: string | null | undefined) => !!soldBy && soldBy !== 'PIECE';

/** "2.25 m" for 225 cm; "3" for three pieces. */
export function qtyText(qty: number, soldBy: string | null | undefined, factor: number | null | undefined): string {
  if (!isMeasured(soldBy)) return String(qty);
  const f = factor && factor > 0 ? factor : 1;
  const places = f >= 1000 ? 3 : f >= 100 ? 2 : 0;
  return `${(qty / f).toFixed(places)} ${UNITS[soldBy!]?.short ?? soldBy!.toLowerCase()}`;
}

/** The per-unit price to show: Rs 450 / m from 450 paise per cm. */
export const pricePerUnitPaise = (pricePaise: number, factor: number | null | undefined) => pricePaise * (factor && factor > 0 ? factor : 1);

/**
 * A length that is not a step of the smallest cut, in words with the two nearest that are; null when
 * it is fine. Inventory refuses the same (BAD_PAYLOAD) -- saying it here first keeps the bill from
 * stopping the shop's queue.
 */
export function stepProblem(name: string, qty: number, soldBy: string, factor: number, minCut: number | null): string | null {
  if (!isMeasured(soldBy) || !minCut || minCut <= 1 || qty % minCut === 0) return null;
  const down = Math.floor(qty / minCut) * minCut;
  const up = down + minCut;
  const options = [down, up].filter(n => n > 0).map(n => qtyText(n, soldBy, factor)).join(' or ');
  return `${name} is cut in steps of ${qtyText(minCut, soldBy, factor)}: ${options}, not ${qtyText(qty, soldBy, factor)}.`;
}
