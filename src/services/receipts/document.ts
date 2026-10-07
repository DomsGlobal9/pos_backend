import { HEADING, COMPOSITION_DECLARATION, DocumentKind } from '../shop/gst-document';
/**
 * The receipt as a DOCUMENT: an ordered list of lines, built from the bill exactly as it was saved.
 * POS-RCPT-002, -009.
 *
 * ONE SOURCE FOR EVERY COPY THAT LEAVES THE SHOP. The PDF (for WhatsApp, email, the digital receipt
 * link's download) is drawn from this, and this is built from the same stored figures the paper
 * receipt prints -- the per-line CGST/SGST/IGST split, the round-off, the payments. Nothing here is
 * worked out again. Two renderings that each did their own arithmetic is how a copy stops matching
 * the paper the customer is holding (the reason RCPT-002 waited for this phase).
 *
 * Plain ASCII only: the PDF uses the fonts every reader has built in, which have no rupee sign, so
 * money reads "Rs 12,999" -- the same way it is written on a cheque.
 */

export type DocLine =
  | { kind: 'text'; text: string; bold?: boolean; center?: boolean }
  | { kind: 'pair'; left: string; right: string; bold?: boolean }
  | { kind: 'rule' }
  | { kind: 'gap' }
  /** The shop's logo as JPEG or PNG bytes, at the top; nothing else is a picture on a receipt. */
  | { kind: 'image'; bytes: Buffer };

export function money(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  // Indian grouping: 12,34,567
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${neg ? '-' : ''}Rs ${grouped}${p ? `.${String(p).padStart(2, '0')}` : ''}`;
}

/** A typed text's own lines, each made printable; blank lines dropped. */
const linesOf = (text: unknown): string[] =>
  typeof text === 'string' ? text.split(/\r?\n/).map(ascii).map(l => l.trim()).filter(Boolean) : [];

/** Anything a built-in PDF font cannot draw becomes its nearest plain equivalent. */
export function ascii(text: string): string {
  return String(text ?? '')
    .replace(/₹\s?/g, 'Rs ')
    .replace(/[•●]/g, '*')
    .replace(/[–—]/g, '-')
    .replace(/[×]/g, 'x')
    .replace(/[·]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '');
}

const METHOD: Record<string, string> = {
  CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CREDIT: 'Store credit', EXCHANGE: 'Exchange credit', POINTS: 'Points', BALANCE: 'Balance'
};

const when = (d: Date | string) => {
  const x = new Date(d);
  return x.toLocaleString('en-IN', { day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/**
 * `sale` is what getSale() returns -- the same object the till's Receipt component renders.
 */
export function receiptDocument(sale: any, opts: { receiptUrl?: string | null; logo?: Buffer | null } = {}): DocLine[] {
  const L: DocLine[] = [];
  const shop = sale.shop ?? {};
  // The logo: one uploaded on the till is a JPEG data URL; Inventory's is an https picture, fetched
  // by the caller (this stays synchronous) and handed in as `logo`.
  const jpeg = 'data:image/jpeg;base64,';
  const logo = opts.logo ?? (typeof shop.logoUrl === 'string' && shop.logoUrl.startsWith(jpeg) ? Buffer.from(shop.logoUrl.slice(jpeg.length), 'base64') : null);
  if (logo) L.push({ kind: 'image', bytes: logo });
  L.push({ kind: 'text', text: ascii(shop.shopName ?? 'Shop'), bold: true, center: true });
  // An address typed on several lines prints on several lines: ascii() drops the line break itself,
  // which ran "Begum Bazaar" into "Hyderabad" on the first live B2B bill (7 Oct).
  for (const part of linesOf(shop.address)) L.push({ kind: 'text', text: part, center: true });
  if (shop.phone) L.push({ kind: 'text', text: `Ph ${ascii(shop.phone)}`, center: true });
  const docKind: DocumentKind = (sale.documentKind as DocumentKind) ?? 'TAX_INVOICE';
  // A plain receipt is from a shop with no GST registration: it has no GSTIN to print.
  if (shop.gstin && docKind !== 'RECEIPT') L.push({ kind: 'text', text: `GSTIN ${ascii(shop.gstin)}`, center: true });
  L.push({ kind: 'rule' });
  L.push({ kind: 'text', text: HEADING[docKind], bold: true, center: true });

  L.push({ kind: 'pair', left: 'Bill', right: ascii(sale.invoiceNo), bold: true });
  L.push({ kind: 'pair', left: 'Date', right: when(sale.createdAt) });
  if (sale.cashier?.name) L.push({ kind: 'pair', left: 'Cashier', right: ascii(sale.cashier.name) });
  if (sale.customer) {
    L.push({ kind: 'pair', left: 'Customer', right: ascii(`${sale.customer.name ? `${sale.customer.name} ` : ''}${sale.customer.phoneMasked ?? ''}`) });
  }
  // A tax invoice to a GST-registered business: the buyer as issued (Rule 46).
  if (sale.buyerGstin) {
    L.push({ kind: 'rule' });
    L.push({ kind: 'text', text: 'Bill to', bold: true });
    if (sale.buyerName) L.push({ kind: 'text', text: ascii(sale.buyerName) });
    for (const part of linesOf(sale.buyerAddress)) L.push({ kind: 'text', text: part });
    L.push({ kind: 'text', text: `GSTIN ${ascii(sale.buyerGstin)}` });
  }
  L.push({ kind: 'rule' });

  for (const line of sale.lines ?? []) {
    L.push({ kind: 'text', text: ascii(line.description) });
    L.push({
      kind: 'pair',
      left: `  ${line.qty} x ${money(line.unitPricePaise)}${line.hsn ? ` HSN ${ascii(line.hsn)}` : ''}`,
      right: money(line.lineTotalPaise)
    });
    if (line.discountPaise > 0) L.push({ kind: 'text', text: `  includes ${money(line.discountPaise)} off` });
  }
  L.push({ kind: 'rule' });

  const cgst = (sale.lines ?? []).reduce((n: number, l: any) => n + (l.cgstPaise ?? 0), 0);
  const sgst = (sale.lines ?? []).reduce((n: number, l: any) => n + (l.sgstPaise ?? 0), 0);
  const igst = (sale.lines ?? []).reduce((n: number, l: any) => n + (l.igstPaise ?? 0), 0);
  L.push({ kind: 'pair', left: 'Subtotal', right: money(sale.subtotalPaise) });
  if (sale.discountPaise > 0) L.push({ kind: 'pair', left: 'Discount', right: money(-sale.discountPaise) });
  if (igst > 0) {
    L.push({ kind: 'pair', left: 'IGST', right: money(igst) });
  } else if (sale.taxPaise > 0) {
    L.push({ kind: 'pair', left: 'CGST', right: money(cgst) });
    L.push({ kind: 'pair', left: 'SGST', right: money(sgst) });
  }
  if (sale.roundOffPaise) L.push({ kind: 'pair', left: 'Round off', right: money(sale.roundOffPaise) });
  L.push({ kind: 'rule' });
  L.push({ kind: 'pair', left: 'TOTAL', right: money(sale.totalPaise), bold: true });

  for (const p of sale.payments ?? []) {
    const note = p.status === 'NEEDS_CHECKING' ? ' (being checked)' : p.status === 'VOID' ? ' (not received)' : '';
    L.push({ kind: 'pair', left: `${METHOD[p.method] ?? p.method}${note}`, right: money(p.amountPaise) });
  }
  const change = (sale.payments ?? []).reduce((n: number, p: any) => n + (p.changePaise ?? 0), 0);
  if (change > 0) L.push({ kind: 'pair', left: 'Change', right: money(change) });
  if (sale.exchangedFrom) {
    L.push({ kind: 'text', text: ascii(`Exchange against ${sale.exchangedFrom.originalInvoiceNo}, credit note ${sale.exchangedFrom.creditNoteNo}`) });
  }

  if (sale.kind === 'KEPT') {
    L.push({ kind: 'rule' });
    // A credit sale is a kept order that went home at once: it is owed, not waiting.
    L.push({ kind: 'text', text: sale.handoverDuePaise ? 'ON CREDIT' : 'KEPT FOR COLLECTION', bold: true, center: true });
    if (sale.note) L.push({ kind: 'text', text: ascii(sale.note) });
    if (sale.promisedAt) {
      L.push({ kind: 'pair', left: 'Collect on', right: new Date(sale.promisedAt).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) });
    }
    if (sale.owedPaise > 0) L.push({ kind: 'pair', left: 'Balance due', right: money(sale.owedPaise), bold: true });
  }

  if (sale.savedPaise > 0) {
    L.push({ kind: 'rule' });
    L.push({ kind: 'text', text: `You saved ${money(sale.savedPaise)}`, bold: true, center: true });
  }
  if (sale.pointsEarned || sale.pointsUsed) {
    L.push({ kind: 'rule' });
    if (sale.pointsUsed) L.push({ kind: 'pair', left: 'Points used', right: String(sale.pointsUsed) });
    if (sale.pointsEarned) L.push({ kind: 'pair', left: 'Points earned', right: String(sale.pointsEarned) });
    if (sale.pointsBalanceAfter != null) L.push({ kind: 'pair', left: 'Points balance', right: String(sale.pointsBalanceAfter), bold: true });
  }
  if (docKind === 'BILL_OF_SUPPLY') {
    L.push({ kind: 'rule' });
    L.push({ kind: 'text', text: COMPOSITION_DECLARATION, center: true });
  }
  if (shop.receiptFooter) {
    L.push({ kind: 'rule' });
    L.push({ kind: 'text', text: ascii(shop.receiptFooter), center: true });
  }
  if (opts.receiptUrl) {
    L.push({ kind: 'gap' });
    L.push({ kind: 'text', text: 'This bill online:', center: true });
    L.push({ kind: 'text', text: ascii(opts.receiptUrl), center: true });
  }
  return L;
}
