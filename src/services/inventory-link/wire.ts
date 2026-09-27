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
  ...(l.taxPaise !== undefined ? { taxPaise: l.taxPaise } : {})
});

const collected = (payments: any[] | undefined) =>
  (payments ?? []).filter(p => !p.status || p.status === 'COLLECTED').map(p => ({ method: p.method, amountPaise: p.amountPaise }));

export function toInventory(eventType: string, payload: any): Record<string, unknown> {
  if (eventType === 'sale.completed') {
    return {
      kind: 'sale.completed',
      invoiceNo: payload.invoiceNo,
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
      totals: { roundOffPaise: payload.totals?.roundOffPaise ?? 0 }
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
      returned: (payload.returned ?? []).map(line),
      taken: (payload.taken ?? []).map(line),
      differencePaise: payload.differencePaise,
      payments: collected(payload.payments)
    };
  }
  return { kind: eventType, ...payload };
}

/** Inventory answers `{ success, data: { answer, detail?, warnings?, orderNumber? } }`. */
export function readAnswer(body: any): { answer: string | null; detail: string | null; warnings: string[]; orderNumber: string | null } {
  const data = body?.data ?? {};
  return {
    answer: data.answer ?? data.status ?? body?.details?.code ?? null,
    detail: data.detail ?? body?.message ?? null,
    warnings: Array.isArray(data.warnings) ? data.warnings.filter((w: unknown) => typeof w === 'string') : [],
    orderNumber: data.orderNumber ?? null
  };
}
