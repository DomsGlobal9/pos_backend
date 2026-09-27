import ExcelJS from 'exceljs';
import { badRequest } from '../../utils/httpError';

/**
 * Reading a shop's item list out of a spreadsheet. POS-EXP-001, POS-STAND-002.
 *
 * Whatever the accountant has: a CSV saved from Excel (with the byte-order mark Excel adds, and
 * semicolons in some regional settings), a tab-separated paste, or the .xlsx itself. Headings are
 * matched loosely -- "Item Code", "item_code" and "SKU" all mean the code -- because a shop's own
 * sheet has its own words and making them rename columns is how the import never gets used.
 */

export type RawRow = Record<string, string>;

const HEADINGS: Record<string, string[]> = {
  code: ['code', 'itemcode', 'sku', 'productcode', 'articleno', 'article', 'designno'],
  name: ['name', 'itemname', 'productname', 'description', 'item', 'product', 'title'],
  price: ['price', 'mrp', 'sellingprice', 'rate', 'saleprice', 'priceinclgst', 'pricers', 'amount'],
  gst: ['gst', 'gstrate', 'gstpercent', 'tax', 'taxrate', 'taxpercent', 'gstslab'],
  hsn: ['hsn', 'hsncode', 'hsnsac'],
  barcode: ['barcode', 'ean', 'upc', 'gtin'],
  qty: ['qty', 'quantity', 'stock', 'instock', 'openingstock', 'pieces'],
  colour: ['colour', 'color', 'shade'],
  size: ['size'],
  group: ['group', 'variantgroup', 'design', 'style', 'parent', 'parentcode'],
  active: ['active', 'onsale', 'enabled', 'status']
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which of our fields each column is. Unknown columns are ignored and named back to the owner. */
export function mapHeadings(headings: string[]) {
  const map: Record<number, string> = {};
  const ignored: string[] = [];
  headings.forEach((h, i) => {
    const key = squash(h);
    if (!key) return;
    const field = Object.entries(HEADINGS).find(([, names]) => names.includes(key))?.[0];
    if (field && !Object.values(map).includes(field)) map[i] = field;
    else ignored.push(h.trim());
  });
  return { map, ignored };
}

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. The delimiter is guessed. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('text' in v && typeof (v as any).text === 'string') return (v as any).text;           // hyperlink
    if ('result' in v) return cellText((v as any).result as ExcelJS.CellValue);            // formula
    if ('richText' in v) return (v as any).richText.map((r: any) => r.text).join('');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

export async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(buf as any); }
  catch { throw badRequest('That file could not be opened as an Excel sheet. Save it as .xlsx or .csv and try again.'); }
  const sheet = book.worksheets[0];
  if (!sheet) throw badRequest('That Excel file has no sheets.');
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, r => {
    const values = r.values as ExcelJS.CellValue[]; // 1-based
    rows.push(values.slice(1).map(cellText));
  });
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

/** A file, as rows keyed by our field names. */
export async function readSheet(file: { name: string; base64: string }): Promise<{ rows: RawRow[]; ignored: string[] }> {
  const buf = Buffer.from(file.base64, 'base64');
  if (buf.length === 0) throw badRequest('That file is empty.');
  if (buf.length > 5 * 1024 * 1024) throw badRequest('That file is over 5 MB. Split it into smaller files.');
  const lower = file.name.toLowerCase();
  const grid = lower.endsWith('.xlsx') ? await parseXlsx(buf)
    : lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv') ? parseCsv(buf.toString('utf8'))
    : lower.endsWith('.xls') ? (() => { throw badRequest('Old .xls files are not read. In Excel, Save As .xlsx or .csv and try again.'); })()
    : (() => { throw badRequest('Choose a .csv or .xlsx file.'); })();
  if (grid.length < 2) throw badRequest('The sheet needs a heading row and at least one item.');
  const { map, ignored } = mapHeadings(grid[0]);
  const fields = Object.values(map);
  const missing = ['code', 'name', 'price'].filter(f => !fields.includes(f));
  if (missing.length) {
    throw badRequest(`The sheet has no ${missing.join(', ')} column. The first row should be headings like: code, name, price, gst, hsn, barcode, qty.`, { code: 'MISSING_COLUMNS', missing });
  }
  const rows = grid.slice(1).map(cells => {
    const row: RawRow = {};
    for (const [i, field] of Object.entries(map)) row[field] = (cells[Number(i)] ?? '').trim();
    return row;
  });
  return { rows, ignored };
}
