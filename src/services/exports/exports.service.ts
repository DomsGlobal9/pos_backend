import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, forbidden } from '../../utils/httpError';
import { dayRange } from '../day-close';

/**
 * Sales for the accountant, as a spreadsheet. POS-EXP-002.
 *
 * Most shops this is for have an accountant with Excel, not a developer with an API. So: every bill
 * and every credit note in the period, one row each, with the GST split AS IT WAS CHARGED (copied
 * off the bill's own lines, never recomputed -- CONTRACTS §1.5). Credit notes are negative, so the
 * column totals are the period's net.
 *
 *   CSV    the Bills sheet only -- opens anywhere, imports into Tally and most accounting tools
 *   Excel  three sheets: Bills, GST by rate (per invoice per rate, what GSTR-1 asks for), Days
 *
 * Rupees in the file, not paise: this is read by a person. Two decimals, no currency sign, so a
 * spreadsheet sees numbers it can add.
 */

const r = (paise: number) => Math.round(paise) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const METHOD: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CREDIT: 'Store credit', EXCHANGE: 'Exchange', POINTS: 'Points', WRITTEN_OFF: 'Written off', VOID: 'Not received', NEEDS_CHECKING: 'Being checked' };

export interface ExportRow {
  date: string; time: string; type: 'Sale' | 'Credit note'; number: string; against: string;
  customer: string; phone: string; gstin: string;
  taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number; paidBy: string;
}

async function gather(actor: Actor, from: string, to: string) {
  if (!may(actor, PERMISSIONS.REPORTS)) throw forbidden('Only a manager or the owner can export sales.', { code: 'NOT_PERMITTED' });
  const start = dayRange(from).start;
  const end = dayRange(to).end;
  if (end <= start) throw badRequest('The end date is before the start date.');
  if (end.getTime() - start.getTime() > 367 * 86_400_000) throw badRequest('At most a year at a time.');

  const sales = await prisma.sale.findMany({
    where: { clientId: actor.clientId, createdAt: { gte: start, lt: end } },
    orderBy: [{ createdAt: 'asc' }, { invoiceNo: 'asc' }],
    select: {
      invoiceNo: true, createdAt: true, roundOffPaise: true, totalPaise: true, buyerGstin: true,
      customer: { select: { name: true, phone: true, gstin: true } },
      lines: { select: { taxRate: true, lineTotalPaise: true, taxPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true } },
      payments: { select: { method: true, amountPaise: true, status: true } }
    }
  });
  const returns = await prisma.return.findMany({
    where: { clientId: actor.clientId, createdAt: { gte: start, lt: end } },
    orderBy: [{ createdAt: 'asc' }, { creditNoteNo: 'asc' }],
    select: {
      id: true, creditNoteNo: true, createdAt: true, totalPaise: true, roundOffPaise: true, refundMethod: true,
      originalSale: { select: { invoiceNo: true, buyerGstin: true, customer: { select: { name: true, phone: true, gstin: true } } } }
    }
  });
  const rLines = await prisma.returnLine.findMany({
    where: { returnId: { in: returns.map(x => x.id) } },
    select: { returnId: true, amountPaise: true, taxPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, saleLine: { select: { taxRate: true } } }
  });
  return { sales, returns, rLines };
}

export async function salesExport(actor: Actor, from: string, to: string) {
  const { sales, returns, rLines } = await gather(actor, from, to);
  const rows: ExportRow[] = [];
  const byRate: { date: string; number: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }[] = [];

  for (const s of sales) {
    const sum = (f: (l: typeof s.lines[number]) => number) => s.lines.reduce((n, l) => n + f(l), 0);
    const methods = new Map<string, number>();
    // Money that never came in is named for what it is, never as a way the bill was paid.
    for (const p of s.payments) { const k = p.status === 'COLLECTED' ? p.method : p.status; methods.set(k, (methods.get(k) ?? 0) + p.amountPaise); }
    rows.push({
      date: localDate(s.createdAt), time: localTime(s.createdAt), type: 'Sale', number: s.invoiceNo, against: '',
      customer: s.customer?.name ?? '', phone: s.customer?.phone ?? '', // The GSTIN the bill was ISSUED to (B2B), never the customer's today.
      gstin: s.buyerGstin ?? '',
      taxable: r(sum(l => l.lineTotalPaise - l.taxPaise)), cgst: r(sum(l => l.cgstPaise)), sgst: r(sum(l => l.sgstPaise)), igst: r(sum(l => l.igstPaise)),
      roundOff: r(s.roundOffPaise), total: r(s.totalPaise),
      paidBy: [...methods].map(([m, a]) => `${METHOD[m] ?? m} ${r(a).toFixed(2)}`).join(' + ')
    });
    const rates = new Map<number, { t: number; c: number; s: number; i: number }>();
    for (const l of s.lines) {
      const g = rates.get(l.taxRate) ?? { t: 0, c: 0, s: 0, i: 0 };
      g.t += l.lineTotalPaise - l.taxPaise; g.c += l.cgstPaise; g.s += l.sgstPaise; g.i += l.igstPaise;
      rates.set(l.taxRate, g);
    }
    for (const [rate, g] of [...rates].sort((a, b) => a[0] - b[0])) {
      byRate.push({ date: localDate(s.createdAt), number: s.invoiceNo, rate, taxable: r(g.t), cgst: r(g.c), sgst: r(g.s), igst: r(g.i) });
    }
  }

  for (const x of returns) {
    const lines = rLines.filter(l => l.returnId === x.id);
    const sum = (f: (l: typeof lines[number]) => number) => lines.reduce((n, l) => n + f(l), 0);
    const c = x.originalSale.customer;
    rows.push({
      date: localDate(x.createdAt), time: localTime(x.createdAt), type: 'Credit note', number: x.creditNoteNo, against: x.originalSale.invoiceNo,
      customer: c?.name ?? '', phone: c?.phone ?? '', gstin: x.originalSale.buyerGstin ?? '',
      taxable: -r(sum(l => l.amountPaise - l.taxPaise)), cgst: -r(sum(l => l.cgstPaise)), sgst: -r(sum(l => l.sgstPaise)), igst: -r(sum(l => l.igstPaise)),
      roundOff: -r(x.roundOffPaise), total: -r(x.totalPaise), paidBy: `Refund: ${METHOD[x.refundMethod] ?? x.refundMethod}`
    });
    const rates = new Map<number, { t: number; c: number; s: number; i: number }>();
    for (const l of lines) {
      const g = rates.get(l.saleLine.taxRate) ?? { t: 0, c: 0, s: 0, i: 0 };
      g.t += l.amountPaise - l.taxPaise; g.c += l.cgstPaise; g.s += l.sgstPaise; g.i += l.igstPaise;
      rates.set(l.saleLine.taxRate, g);
    }
    for (const [rate, g] of [...rates].sort((a, b) => a[0] - b[0])) {
      byRate.push({ date: localDate(x.createdAt), number: x.creditNoteNo, rate, taxable: -r(g.t), cgst: -r(g.c), sgst: -r(g.s), igst: -r(g.i) });
    }
  }

  rows.sort((a, b) => (a.date + a.time + a.number).localeCompare(b.date + b.time + b.number));
  byRate.sort((a, b) => (a.date + a.number).localeCompare(b.date + b.number) || a.rate - b.rate);
  return { rows, byRate };
}

const COLUMNS: [keyof ExportRow, string][] = [
  ['date', 'Date'], ['time', 'Time'], ['type', 'Type'], ['number', 'Number'], ['against', 'Against bill'],
  ['customer', 'Customer'], ['phone', 'Phone'], ['gstin', 'Customer GSTIN'],
  ['taxable', 'Taxable value'], ['cgst', 'CGST'], ['sgst', 'SGST'], ['igst', 'IGST'], ['roundOff', 'Round off'], ['total', 'Total'], ['paidBy', 'Paid by']
];

/** A cell for CSV: quoted when it must be, and never read as a formula by Excel (CSV injection). */
function csvCell(v: unknown) {
  let s = typeof v === 'number' ? v.toFixed(2) : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number') s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function salesCsv(actor: Actor, from: string, to: string) {
  const { rows } = await salesExport(actor, from, to);
  const lines = [COLUMNS.map(c => c[1]).join(',')].concat(rows.map(row => COLUMNS.map(([k]) => csvCell(row[k])).join(',')));
  // The byte-order mark makes Excel read the rupee names and Tamil/Hindi customer names correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * GSTR-1 TABLE 12: the HSN-wise summary, B2B and B2C apart (two tables since 2025). The till's export
 * is the GST record for till bills (Inventory files none), so this is the sheet an accountant copies
 * into the return. Only tax invoices count -- a Bill of Supply or a plain receipt carries no GST to
 * report. Credit notes in the same period come off their bill's HSN and rate. Quantity in NOS.
 */
export async function hsnSummary(actor: Actor, from: string, to: string) {
  const start = dayRange(from).start;
  const end = dayRange(to).end;
  const sold = await prisma.saleLine.findMany({
    where: { sale: { clientId: actor.clientId, createdAt: { gte: start, lt: end }, documentKind: 'TAX_INVOICE' } },
    select: { hsn: true, description: true, qty: true, taxRate: true, lineTotalPaise: true, taxPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, sale: { select: { buyerGstin: true } } }
  });
  const back = await prisma.returnLine.findMany({
    where: { returnRow: { clientId: actor.clientId, createdAt: { gte: start, lt: end } }, saleLine: { sale: { documentKind: 'TAX_INVOICE' } } },
    select: { qty: true, amountPaise: true, taxPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, saleLine: { select: { hsn: true, description: true, taxRate: true, sale: { select: { buyerGstin: true } } } } }
  });
  type Row = { supply: 'B2B' | 'B2C'; hsn: string; description: string; uqc: string; qty: number; value: number; taxable: number; igst: number; cgst: number; sgst: number; rate: number };
  const groups = new Map<string, Row>();
  const add = (supply: 'B2B' | 'B2C', hsn: string | null, description: string, rate: number, sign: 1 | -1, qty: number, total: number, tax: number, igst: number, cgst: number, sgst: number) => {
    const code = hsn?.trim() || 'NO HSN';
    const key = `${supply}|${code}|${rate}`;
    const g = groups.get(key) ?? { supply, hsn: code, description, uqc: 'NOS', qty: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, rate };
    g.qty += sign * qty; g.value += sign * total; g.taxable += sign * (total - tax);
    g.igst += sign * igst; g.cgst += sign * cgst; g.sgst += sign * sgst;
    groups.set(key, g);
  };
  for (const l of sold) add(l.sale.buyerGstin ? 'B2B' : 'B2C', l.hsn, l.description, Number(l.taxRate), 1, l.qty, l.lineTotalPaise, l.taxPaise, l.igstPaise, l.cgstPaise, l.sgstPaise);
  for (const l of back) add(l.saleLine.sale.buyerGstin ? 'B2B' : 'B2C', l.saleLine.hsn, l.saleLine.description, Number(l.saleLine.taxRate), -1, l.qty, l.amountPaise, l.taxPaise, l.igstPaise, l.cgstPaise, l.sgstPaise);
  return [...groups.values()]
    .map(g => ({ ...g, value: r(g.value), taxable: r(g.taxable), igst: r(g.igst), cgst: r(g.cgst), sgst: r(g.sgst) }))
    .sort((a, b) => a.supply.localeCompare(b.supply) || a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
}

export async function salesXlsx(actor: Actor, from: string, to: string): Promise<Buffer> {
  const { rows, byRate } = await salesExport(actor, from, to);
  const book = new ExcelJS.Workbook();
  book.creator = 'ScaleEzy POS';
  const money = '#,##0.00';

  const bills = book.addWorksheet('Bills', { views: [{ state: 'frozen', ySplit: 1 }] });
  bills.columns = COLUMNS.map(([k, h]) => ({ header: h, key: k, width: ['customer', 'paidBy'].includes(k) ? 26 : k === 'number' || k === 'against' ? 18 : 13 }));
  rows.forEach(row => bills.addRow(row));
  for (const k of ['taxable', 'cgst', 'sgst', 'igst', 'roundOff', 'total']) bills.getColumn(k).numFmt = money;
  if (rows.length) {
    const total = bills.addRow({ date: 'Total', ...Object.fromEntries(['taxable', 'cgst', 'sgst', 'igst', 'roundOff', 'total'].map(k => [k, Math.round(rows.reduce((n, x) => n + (x as any)[k], 0) * 100) / 100])) });
    total.font = { bold: true };
  }
  bills.getRow(1).font = { bold: true };

  const gst = book.addWorksheet('GST by rate', { views: [{ state: 'frozen', ySplit: 1 }] });
  gst.columns = [
    { header: 'Date', key: 'date', width: 12 }, { header: 'Number', key: 'number', width: 18 }, { header: 'GST rate %', key: 'rate', width: 11 },
    { header: 'Taxable value', key: 'taxable', width: 14 }, { header: 'CGST', key: 'cgst', width: 12 }, { header: 'SGST', key: 'sgst', width: 12 }, { header: 'IGST', key: 'igst', width: 12 }
  ];
  byRate.forEach(x => gst.addRow(x));
  for (const k of ['taxable', 'cgst', 'sgst', 'igst']) gst.getColumn(k).numFmt = money;
  gst.getRow(1).font = { bold: true };

  const hsn = book.addWorksheet('HSN summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  hsn.columns = [
    { header: 'B2B / B2C', key: 'supply', width: 10 }, { header: 'HSN', key: 'hsn', width: 10 }, { header: 'Description', key: 'description', width: 30 },
    { header: 'UQC', key: 'uqc', width: 6 }, { header: 'Total quantity', key: 'qty', width: 13 }, { header: 'Total value', key: 'value', width: 14 },
    { header: 'Rate %', key: 'rate', width: 8 }, { header: 'Taxable value', key: 'taxable', width: 14 },
    { header: 'IGST', key: 'igst', width: 12 }, { header: 'CGST', key: 'cgst', width: 12 }, { header: 'SGST', key: 'sgst', width: 12 }
  ];
  (await hsnSummary(actor, from, to)).forEach(x => hsn.addRow(x));
  for (const k of ['value', 'taxable', 'igst', 'cgst', 'sgst']) hsn.getColumn(k).numFmt = money;
  hsn.getRow(1).font = { bold: true };

  const days = book.addWorksheet('Days', { views: [{ state: 'frozen', ySplit: 1 }] });
  days.columns = [
    { header: 'Date', key: 'date', width: 12 }, { header: 'Bills', key: 'bills', width: 8 }, { header: 'Credit notes', key: 'notes', width: 12 },
    { header: 'Taxable value', key: 'taxable', width: 14 }, { header: 'GST', key: 'gst', width: 12 }, { header: 'Net total', key: 'total', width: 14 }
  ];
  const perDay = new Map<string, { bills: number; notes: number; taxable: number; gst: number; total: number }>();
  for (const x of rows) {
    const d = perDay.get(x.date) ?? { bills: 0, notes: 0, taxable: 0, gst: 0, total: 0 };
    if (x.type === 'Sale') d.bills++; else d.notes++;
    d.taxable += x.taxable; d.gst += x.cgst + x.sgst + x.igst; d.total += x.total;
    perDay.set(x.date, d);
  }
  for (const [date, d] of perDay) days.addRow({ date, ...d, taxable: Math.round(d.taxable * 100) / 100, gst: Math.round(d.gst * 100) / 100, total: Math.round(d.total * 100) / 100 });
  for (const k of ['taxable', 'gst', 'total']) days.getColumn(k).numFmt = money;
  days.getRow(1).font = { bold: true };

  return Buffer.from(await book.xlsx.writeBuffer());
}
