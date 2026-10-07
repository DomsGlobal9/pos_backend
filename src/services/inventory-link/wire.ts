/**
 * The POS's outbox event, in the shape Inventory's POS endpoint reads. Contract §4 (as built,
 * Inventory commit e0ca93a -- found by the first real end-to-end run on 27 Sep).
 *
 * The outbox keeps the POS's own canonical event (MASTER §7), because a shop's own software will
 * read the same rows in Phase 12. Inventory is one consumer, and this is its dialect:
 *
 *   - FLAT, with `kind` -- not an envelope with `eventType` and `payload`
 *   - tax as basis points (`taxRateBps`, 500 = 5%) -- the POS line carries a percent
 *   - a return names the bill it reverses as `againstInvoiceNo`, and each line's worth as
 *     `lineTotalPaise`
 *   - an exchange is keyed `exchangeNo` (the new bill) and its outgoing lines are `sold`, not
 *     `taken`
 *
 * Payments: only money actually in (COLLECTED). A UPI still being checked is not takings until it
 * is -- and a payment's later life (a balance collected, a check resolved) is a `payment.updated`
 * event that does not exist yet (open item in the contract).
 */

const line = (l: any) => ({
  itemCode: l.itemCode,
  qty: l.qty,
  lineTotalPaise: l.lineTotalPaise ?? l.amountPaise,
  ...(l.unitPricePaise !== undefined ? { unitPricePaise: l.unitPricePaise } : {}),
  ...(l.discountPaise !== undefined ? { discountPaise: l.discountPaise } : {}),
  ...(l.taxRate !== undefined && l.taxRate !== null ? { taxRateBps: Math.round(Number(l.taxRate) * 100) } : {}),
  ...(l.taxPaise !== undefined ? { taxPaise: l.taxPaise } : {}),
  ...(Array.isArray(l.offers) && l.offers.length ? { offers: l.offers.map((o: any) => ({ offerId: o.offerId, discountPaise: o.discountPaise })) } : {})
});

/**
 * How the money went back, in Inventory's words (Inventory, 27 Sep): its day book shows refunds by
 * method, so a UPI refund filed as cash would make a drawer count wrong. One `refund` -- the largest,
 * when a refund was split -- plus the whole list. Store credit is Inventory's CREDIT; the part of an
 * exchange settled by the new goods is not money and is left out.
 */
const REFUND: Record<string, string> = { CASH: 'CASH', UPI: 'UPI', CARD: 'CARD', STORE_CREDIT: 'CREDIT' };
function refundOf(refunds: any[] | undefined) {
  const list = (refunds ?? [])
    .filter(r => REFUND[r.method] && r.amountPaise > 0)
    .map(r => ({ method: REFUND[r.method], amountPaise: r.amountPaise, ...(r.reference ? { reference: r.reference } : {}) }));
  if (list.length === 0) return {};
  const main = [...list].sort((a, b) => b.amountPaise - a.amountPaise)[0];
  return { refund: { method: main.method, ...(main.reference ? { reference: main.reference } : {}) }, refunds: list };
}

const collected = (payments: any[] | undefined) =>
  (payments ?? []).filter(p => !p.status || p.status === 'COLLECTED').map(p => ({ method: p.method, amountPaise: p.amountPaise, ...(p.holdId ? { holdId: p.holdId } : {}), ...(p.qrId ? { qrId: p.qrId } : {}) }));

export function toInventory(eventType: string, payload: any): Record<string, unknown> {
  if (eventType === 'sale.completed') {
    return {
      kind: 'sale.completed',
      invoiceNo: payload.invoiceNo,
      ...(payload.quoteId ? { quoteId: payload.quoteId } : {}),
      ...(payload.couponCode ? { couponCode: payload.couponCode } : {}),
      occurredAt: payload.occurredAt,
      customer: payload.customer ?? null,
      lines: (payload.lines ?? []).map(line),
      totals: { roundOffPaise: payload.totals?.roundOffPaise ?? 0 },
      payments: collected(payload.payments)
    };
  }
  if (eventType === 'sale.returned') {
    return {
      kind: 'sale.returned',
      creditNoteNo: payload.creditNoteNo,
      againstInvoiceNo: payload.originalInvoiceNo,
      occurredAt: payload.occurredAt,
      lines: (payload.lines ?? []).map(line),
      totals: { roundOffPaise: payload.totals?.roundOffPaise ?? 0 },
      ...refundOf(payload.refunds)
    };
  }
  if (eventType === 'sale.exchanged') {
    return {
      kind: 'sale.exchanged',
      creditNoteNo: payload.creditNoteNo,
      againstInvoiceNo: payload.originalInvoiceNo,
      newInvoiceNo: payload.newInvoiceNo,
      occurredAt: payload.occurredAt,
      customer: payload.customer ?? null,
      /*
       * `exchangeNo` and `sold` are Inventory's names, and neither is in the contract (§4.3 says
       * `taken`, idempotent on creditNoteNo). Found 5 Oct by reading Inventory's own code: without
       * exchangeNo it answers BAD_PAYLOAD, which stops the shop's queue at the first exchange and
       * every sale behind it. Both suites missed it -- the POS's stand-in waved any `kind` through
       * and Inventory's suite sends its own names.
       *
       * The NEW bill is the number sent, not the credit note: Inventory files the order it creates
       * under `externalOrderId = exchangeNo`, so newInvoiceNo keeps a payment.updated collected
       * later against that bill able to find its order. delivery.service asks /events/status for
       * the same number.
       */
      exchangeNo: payload.newInvoiceNo,
      returned: (payload.returned ?? []).map(line),
      sold: (payload.taken ?? []).map(line),
      differencePaise: payload.differencePaise,
      payments: collected(payload.payments),
      // New goods cheaper than what came back: the rest was given back, and how.
      ...refundOf(payload.refunds)
    };
  }
  if (eventType === 'payment.updated') {
    // Inventory takes CASH, UPI, CARD, POINTS and CREDIT. A line in anything else is not money it
    // counts (BALANCE and EXCHANGE are bookkeeping) and is left out.
    const methods = ['CASH', 'UPI', 'CARD', 'POINTS', 'CREDIT'];
    return {
      kind: 'payment.updated',
      invoiceNo: payload.invoiceNo,
      idempotencyKey: payload.idempotencyKey,
      occurredAt: payload.occurredAt,
      payments: (payload.payments ?? []).filter((p: any) => methods.includes(p.method))
    };
  }
  return { kind: eventType, ...payload };
}

/**
 * Inventory answers `{ success, data: { answer, detail?, warnings?, orderNumber?, reference? } }`.
 * A sale is answered `202 { answer: ACCEPTED, reference }` and applied moments later; its ending
 * is read from `GET /events/status`, whose `status` is QUEUED, RUNNING, APPLIED or REJECTED.
 */
export function readAnswer(body: any): {
  answer: string | null; detail: string | null; warnings: string[]; orderNumber: string | null; reference: string | null
} {
  const data = body?.data ?? {};
  return {
    reference: typeof data.reference === 'string' ? data.reference : null,
    answer: data.answer ?? data.status ?? body?.details?.code ?? null,
    detail: data.detail ?? body?.message ?? null,
    warnings: Array.isArray(data.warnings) ? data.warnings.filter((w: unknown) => typeof w === 'string') : [],
    orderNumber: data.orderNumber ?? null
  };
}
