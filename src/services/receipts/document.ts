import { HEADING, COMPOSITION_DECLARATION, DocumentKind } from '../shop/gst-document';
import { stateOf } from '../shop/gst-states';
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
  if (sale.salespersonName) L.push({ kind: 'pair', left: 'Served by', right: ascii(sale.salespersonName) });
  if (sale.customer) {
    L.push({ kind: 'pair', left: 'Customer', right: ascii(`${sale.customer.name ? `${sale.customer.name} ` : ''}${sale.customer.phoneMasked ?? ''}`) });
  }
  // A tax invoice to a GST-registered business: the buyer as issued (Rule 46).
  if (sale.buyerGstin || sale.buyerName || sale.buyerAddress) {
    L.push({ kind: 'rule' });
    L.push({ kind: 'text', text: 'Bill to', bold: true });
    if (sale.buyerName) L.push({ kind: 'text', text: ascii(sale.buyerName) });
    for (const part of linesOf(sale.buyerAddress)) L.push({ kind: 'text', text: part });
    if (sale.buyerGstin) L.push({ kind: 'text', text: `GSTIN ${ascii(sale.buyerGstin)}` });
    // An unregistered customer on a large bill: the state too (Rule 46). A counter sale is supplied
    // in the shop's own state, so it is the shop's.
    else if (stateOf(shop.gstin)) L.push({ kind: 'text', text: `State ${stateOf(shop.gstin)}` });
  }
  L.push({ kind: 'rule' });

  for (const line of sale.lines ?? []) {
    L.push({ kind: 'text', text: ascii(line.description) });
    L.push({
      kind: 'pair',
      left: `  ${line.qty} x ${money(line.unitPricePaise)}`,
      right: money(line.lineTotalPaise)
    });
    // On a line of its own: beside the price it ran past 80 mm and wrapped mid-phrase (live, 8 Oct).
    const codes = [line.hsn ? `HSN ${ascii(line.hsn)}` : '', docKind === 'TAX_INVOICE' ? `GST ${Number(line.taxRate)}%` : ''].filter(Boolean).join('  ');
    if (codes) L.push({ kind: 'text', text: `  ${codes}` });
    if (line.discountPaise > 0) L.push({ kind: 'text', text: `  includes ${money(line.discountPaise)} off` });
  }
  L.push({ kind: 'rule' });

  const igst = (sale.lines ?? []).reduce((n: number, l: any) => n + (l.igstPaise ?? 0), 0);
  L.push({ kind: 'pair', left: 'Subtotal', right: money(sale.subtotalPaise) });
  if (sale.discountPaise > 0) L.push({ kind: 'pair', left: 'Discount', right: money(-sale.discountPaise) });
  // Rule 46: the taxable value, and each tax with its RATE -- one CGST/SGST (or IGST) pair per rate.
  if (sale.taxPaise > 0) {
    L.push({ kind: 'pair', left: 'Taxable value', right: money(sale.totalPaise - sale.roundOffPaise - sale.taxPaise) });
    for (const g of byRate(sale.lines ?? [])) {
      if (igst > 0) L.push({ kind: 'pair', left: `IGST ${g.rate}%`, right: money(g.igst) });
      else {
        L.push({ kind: 'pair', left: `CGST ${g.rate / 2}%`, right: money(g.cgst) });
        L.push({ kind: 'pair', left: `SGST ${g.rate / 2}%`, right: money(g.sgst) });
      }
    }
  }
  if (sale.roundOffPaise) L.push({ kind: 'pair', left: 'Round off', right: money(sale.roundOffPaise) });
  L.push({ kind: 'rule' });
  L.push({ kind: 'pair', left: 'TOTAL', right: money(sale.totalPaise), bold: true });

  for (const p of sale.payments ?? []) {
    const note = p.status === 'NEEDS_CHECKING' ? ' (being checked)' : p.status === 'VOID' ? ' (not received)' : '';
    const label = p.status === 'WRITTEN_OFF' ? 'Written off' : `${METHOD[p.method] ?? p.method}${note}`;
    L.push({ kind: 'pair', left: label, right: money(p.amountPaise) });
  }
  const change = (sale.payments ?? []).reduce((n: number, p: any) => n + (p.changePaise ?? 0), 0);
  if (change > 0) L.push({ kind: 'pair', left: 'Change', right: money(change) });
  if (sale.exchangedFrom) {
    L.push({ kind: 'text', text: ascii(`Exchange against ${sale.exchangedFrom.originalInvoiceNo}, credit note ${sale.exchangedFrom.creditNoteNo}`) });
  }

  if (sale.kind === 'KEPT') {
    L.push({ kind: 'rule' });
    // A credit sale is a kept order that went home at once: it is owed, not waiting.
    // Reprinted later it says where things stand now, not what they were (live, 8 Oct).
    const writtenOff = (sale.payments ?? []).some((p: any) => p.status === 'WRITTEN_OFF');
    const heading = sale.handoverDuePaise
      ? (sale.owedPaise > 0 ? 'ON CREDIT' : writtenOff ? 'BALANCE WRITTEN OFF' : 'CREDIT PAID IN FULL')
      : (sale.fulfilment === 'HANDED_OVER' ? 'COLLECTED' : 'KEPT FOR COLLECTION');
    L.push({ kind: 'text', text: heading, bold: true, center: true });
    if (sale.note) L.push({ kind: 'text', text: ascii(sale.note) });
    if (sale.promisedAt && sale.fulfilment !== 'HANDED_OVER') {
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

/** The tax charged, grouped by the rate each line was charged at; rates with no tax are left out. */
function byRate(lines: any[]) {
  const groups = new Map<number, { rate: number; cgst: number; sgst: number; igst: number }>();
  for (const l of lines) {
    if (!l.taxPaise) continue;
    const rate = Number(l.taxRate);
    const g = groups.get(rate) ?? { rate, cgst: 0, sgst: 0, igst: 0 };
    g.cgst += l.cgstPaise ?? 0; g.sgst += l.sgstPaise ?? 0; g.igst += l.igstPaise ?? 0;
    groups.set(rate, g);
  }
  return [...groups.values()].sort((a, b) => a.rate - b.rate);
}
