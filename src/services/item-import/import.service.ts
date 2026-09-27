import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { record } from '../audit';
import { RawRow, readSheet } from './parse';

/**
 * Putting a standalone shop's items into the till: from a spreadsheet (POS-EXP-001, POS-STAND-002)
 * or from the shop's own software (POS-API-004, -005). One set of rules for both.
 *
 * STANDALONE ONLY. A shop connected to Inventory gets its items from Inventory; two sources for one
 * list is how a price changes in one place and not the other. Refused, saying where items come from.
 *
 * ALL OR NOTHING. Every row is checked first. If any row is wrong nothing is saved, and every
 * problem is listed by row in words ("Row 14: the price is missing"). Half a price list is worse
 * than none -- nobody knows which half went in.
 *
 * MATCHED BY CODE. A code already in the till is updated; a new one is added. Bills already made
 * are untouched: each sale line keeps the price and tax it was sold at (CONTRACTS §1.5).
 *
 * GST: whole percent from the rates in use. 12% and 28% are accepted (older stock, and the rate
 * decision is still open -- CHANGELOG #5) but flagged, because those slabs were removed on
 * 22 Sep 2025 for most goods. Nothing is guessed or changed.
 */

export interface ItemInput {
  code: string;
  name: string;
  pricePaise: number;
  taxRate: number;
  hsn: string | null;
  barcode: string | null;
  qty: number | null;
  colour: string | null;
  size: string | null;
  group: string | null;
  active: boolean;
  /**
   * The fields this row actually carried. An item that is already in the till only has THESE
   * changed: a sheet of code, name and price must not wipe the barcodes, HSN and sizes it never
   * mentioned.
   */
  given: string[];
}

const RATES = [0, 3, 5, 12, 18, 28, 40];
const OLD_SLABS = [12, 28];
export const MAX_ROWS = 2000;

function mustManage(actor: Actor) {
  const ok = actor.kind === 'API_KEY' ? actor.permissions.includes('api:items:write') : may(actor, PERMISSIONS.SETTINGS);
  if (!ok) throw forbidden('Only the owner can change the item list.', { code: 'NOT_PERMITTED' });
}

async function mustBeStandalone(clientId: string) {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId }, select: { connected: true } });
  if (link?.connected) {
    throw conflict('This shop\'s items come from Inventory. Change them there; the till picks them up on the next refresh.', { code: 'INVENTORY_OWNS_ITEMS' });
  }
}

/** Rupees as typed in a sheet -- "1299", "1,299.00", "₹ 1299" -- to paise. Null if it is not money. */
function rupeesToPaise(raw: string): number | null {
  const s = raw.replace(/[₹,\s]|Rs\.?|INR/gi, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

const text = (v: unknown, max: number) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** One row checked. `price` is rupees from a sheet, `pricePaise` an integer from the API. */
export function checkRow(raw: Record<string, unknown>, from: 'sheet' | 'api'): { item?: ItemInput; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];

  const code = text(raw.code, 60);
  if (!code) problems.push('the code is missing');
  else if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(code)) problems.push(`the code "${code}" has characters a scanner or search cannot use (letters, numbers, - _ . / only)`);

  const name = text(raw.name, 120);
  if (!name) problems.push('the name is missing');

  let pricePaise: number | null = null;
  if (from === 'sheet') {
    const p = String(raw.price ?? '').trim();
    if (!p) problems.push('the price is missing');
    else if ((pricePaise = rupeesToPaise(p)) === null) problems.push(`"${p}" is not a price -- write it like 1299 or 1299.50`);
  } else {
    const p = raw.pricePaise;
    if (p === undefined || p === null) problems.push('pricePaise is missing');
    else if (!Number.isInteger(p)) problems.push('pricePaise must be a whole number of paise (Rs 1,299 is 129900)');
    else pricePaise = p as number;
  }
  if (pricePaise !== null && pricePaise <= 0) problems.push('the price must be more than zero');
  if (pricePaise !== null && pricePaise > 100_00_000_00) problems.push('the price is over Rs 1 crore -- check it');

  const gstRaw = from === 'sheet' ? String(raw.gst ?? '').replace('%', '').trim() : raw.taxRate;
  let taxRate = 0;
  if (gstRaw === '' || gstRaw === undefined || gstRaw === null) problems.push(from === 'sheet' ? 'the GST rate is missing (write 5 for 5%)' : 'taxRate is missing');
  else {
    const n = Number(gstRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) problems.push(`GST "${gstRaw}" is not a whole percent`);
    else if (!RATES.includes(n)) problems.push(`GST ${n}% is not a rate in use (${RATES.join(', ')})`);
    else {
      taxRate = n;
      if (OLD_SLABS.includes(n)) notes.push(`GST ${n}%: this slab was removed on 22 Sep 2025 for most goods -- check with your accountant`);
    }
  }

  const hsn = text(raw.hsn, 8);
  if (hsn && !/^\d{4,8}$/.test(hsn)) problems.push(`HSN "${hsn}" should be 4 to 8 digits`);

  const barcode = text(raw.barcode, 14);
  if (barcode && !/^\d{8,14}$/.test(barcode)) problems.push(`barcode "${barcode}" should be 8 to 14 digits`);

  let qty: number | null = null;
  const q = from === 'sheet' ? String(raw.qty ?? '').trim() : raw.qty;
  if (q !== '' && q !== undefined && q !== null) {
    const n = Number(q);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) problems.push(`quantity "${q}" should be a whole number, 0 or more`);
    else qty = n;
  }

  let active = true;
  const a = raw.active;
  if (a !== undefined && a !== null && a !== '') {
    const v = String(a).trim().toLowerCase();
    if (['false', 'no', 'n', '0', 'inactive', 'off'].includes(v)) active = false;
    else if (!['true', 'yes', 'y', '1', 'active', 'on'].includes(v)) problems.push(`"${a}" should be yes or no`);
  }

  if (problems.length) return { problems, notes };
  const has = (k: string) => raw[k] !== undefined && raw[k] !== null;
  const priceKey = from === 'sheet' ? 'price' : 'pricePaise';
  const taxKey = from === 'sheet' ? 'gst' : 'taxRate';
  const given = ['name', 'hsn', 'barcode', 'colour', 'size', 'group', 'active'].filter(has)
    .concat(has(priceKey) ? ['pricePaise'] : [], has(taxKey) ? ['taxRate'] : [], qty !== null ? ['qty'] : []);
  return {
    problems, notes,
    item: {
      code: code!, name: name!, pricePaise: pricePaise!, taxRate, hsn, barcode, qty,
      colour: text(raw.colour, 40), size: text(raw.size, 20), group: text(raw.group, 60), active, given
    }
  };
}

export interface Checked {
  items: ItemInput[];
  /** "Row 14: the price is missing; GST 7% is not a rate in use" -- row numbers as the sheet shows them. */
  problems: string[];
  notes: string[];
  added: number;
  updated: number;
  unchanged: number;
}

/**
 * Every row checked against the rules and against each other and the till: the same code twice, a
 * barcode already on a different item. `rowNumber(i)` names a row as the owner will find it.
 */
export async function checkAll(clientId: string, raws: Record<string, unknown>[], from: 'sheet' | 'api', rowNumber: (i: number) => string): Promise<Checked> {
  if (raws.length === 0) throw badRequest('There are no items in it.');
  if (raws.length > MAX_ROWS) throw badRequest(`At most ${MAX_ROWS} items at once. Split the list.`);

  // Problems are gathered per row and listed in row order at the end, whichever check found them.
  const byRow = new Map<number, string[]>();
  const add = (i: number, p: string) => byRow.set(i, [...(byRow.get(i) ?? []), p]);
  const valid = new Map<number, ItemInput>();
  const notes: string[] = [];
  // Duplicates are looked for across EVERY row, valid or not: a code typed twice is a problem even
  // when the first copy has something else wrong with it too.
  const firstCode = new Map<string, number>();
  const firstBarcode = new Map<string, number>();
  raws.forEach((raw, i) => {
    const r = checkRow(raw, from);
    r.problems.forEach(p => add(i, p));
    const code = String(raw.code ?? '').trim();
    if (code) {
      const dup = firstCode.get(code.toLowerCase());
      if (dup !== undefined) add(i, `code ${code} is also on ${rowNumber(dup)}`);
      else firstCode.set(code.toLowerCase(), i);
    }
    const barcode = String(raw.barcode ?? '').trim();
    if (barcode) {
      const dupB = firstBarcode.get(barcode);
      if (dupB !== undefined) add(i, `barcode ${barcode} is also on ${rowNumber(dupB)}`);
      else firstBarcode.set(barcode, i);
    }
    if (r.item) valid.set(i, r.item);
    for (const n of r.notes) notes.push(`${rowNumber(i)}: ${n}`);
  });

  // Against the till: a barcode already on an item with a DIFFERENT code -- unless that item is in
  // this same list and is getting a different barcode (two barcodes swapped in one upload).
  const candidates = [...valid.values()];
  const existing = await prisma.item.findMany({
    where: { clientId, OR: [{ code: { in: candidates.map(i => i.code) } }, { barcode: { in: candidates.filter(i => i.barcode).map(i => i.barcode!) } }] },
    select: { code: true, name: true, barcode: true, pricePaise: true, taxRate: true, hsn: true, colour: true, size: true, variantGroup: true, active: true, cachedQty: true }
  });
  const byCode = new Map(existing.map(e => [e.code, e]));
  for (const [i, it] of valid) {
    if (!it.barcode) continue;
    const other = existing.find(e => e.barcode === it.barcode && e.code !== it.code);
    if (other && !candidates.some(x => x.code === other.code && x.given.includes('barcode') && x.barcode !== it.barcode)) {
      add(i, `barcode ${it.barcode} is already on ${other.code} (${other.name})`);
    }
  }

  const problems = [...byRow.keys()].sort((a, b) => a - b).map(i => `${rowNumber(i)}: ${byRow.get(i)!.join('; ')}`);
  const items = [...valid].filter(([i]) => !byRow.has(i)).map(([, it]) => it);

  let added = 0, updated = 0, unchanged = 0;
  for (const it of items) {
    const e = byCode.get(it.code);
    if (!e) added++;
    else {
      const now = fieldsOf(it);
      const before: Record<string, unknown> = {
        name: e.name, pricePaise: e.pricePaise, taxRate: e.taxRate, hsn: e.hsn ?? null, barcode: e.barcode ?? null,
        colour: e.colour ?? null, size: e.size ?? null, variantGroup: e.variantGroup ?? null, active: e.active, cachedQty: e.cachedQty
      };
      if (Object.entries(now).every(([k, v]) => k === 'cachedQtyAt' || before[k] === v)) unchanged++;
      else updated++;
    }
  }
  return { items, problems, notes, added, updated, unchanged };
}

/** Only what the row carried, as columns. */
function fieldsOf(it: ItemInput): Record<string, unknown> {
  const all: Record<string, unknown> = {
    name: it.name, pricePaise: it.pricePaise, taxRate: it.taxRate, hsn: it.hsn, barcode: it.barcode,
    colour: it.colour, size: it.size, variantGroup: it.group, active: it.active, cachedQty: it.qty
  };
  const key = (f: string) => (f === 'group' ? 'variantGroup' : f === 'qty' ? 'cachedQty' : f);
  return Object.fromEntries(it.given.map(f => [key(f), all[key(f)]]));
}

/** Save checked items. One transaction: all of them or none. */
async function save(clientId: string, items: ItemInput[]) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Barcodes are unique per shop. Take the barcode off the items in this list that are getting a
    // new one before any is set, so swapping two barcodes in one upload does not trip over itself.
    const withBarcode = items.filter(i => i.given.includes('barcode')).map(i => i.code);
    if (withBarcode.length) {
      await tx.item.updateMany({ where: { clientId, code: { in: withBarcode }, barcode: { not: null } }, data: { barcode: null } });
    }
    for (const it of items) {
      const changes = fieldsOf(it);
      if ('cachedQty' in changes) changes.cachedQtyAt = now;
      await tx.item.upsert({
        where: { clientId_code: { clientId, code: it.code } },
        // A new item takes every field (missing ones empty); an existing one only what was sent.
        create: {
          clientId, code: it.code, name: it.name, pricePaise: it.pricePaise, taxRate: it.taxRate, hsn: it.hsn, barcode: it.barcode,
          colour: it.colour, size: it.size, variantGroup: it.group, active: it.active,
          ...(it.qty !== null ? { cachedQty: it.qty, cachedQtyAt: now } : {})
        },
        update: changes
      });
    }
  }, { timeout: 120_000, maxWait: 15_000 });
}

/** A spreadsheet: check it (preview) or check and save it (import). */
export async function importSheet(actor: Actor, file: { name: string; base64: string }, commit: boolean) {
  mustManage(actor);
  await mustBeStandalone(actor.clientId);
  const { rows, ignored } = await readSheet(file);
  // Row 1 is the headings, so the first item is on row 2 -- as Excel numbers it.
  const checked = await checkAll(actor.clientId, rows as RawRow[], 'sheet', i => `Row ${i + 2}`);
  const summary = {
    rows: rows.length, added: checked.added, updated: checked.updated, unchanged: checked.unchanged,
    problems: checked.problems, notes: checked.notes, ignoredColumns: ignored,
    sample: checked.items.slice(0, 5).map(i => ({ code: i.code, name: i.name, pricePaise: i.pricePaise, taxRate: i.taxRate, qty: i.qty }))
  };
  if (!commit) return { ...summary, saved: false };
  if (checked.problems.length) {
    throw badRequest(`Nothing was saved: ${checked.problems.length} row${checked.problems.length === 1 ? ' needs' : 's need'} fixing first.`, { code: 'ROWS_NEED_FIXING', problems: checked.problems });
  }
  await save(actor.clientId, checked.items);
  await record(actor, { action: 'items.imported', subject: file.name.slice(0, 80), detail: { added: checked.added, updated: checked.updated, unchanged: checked.unchanged } });
  return { ...summary, saved: true };
}

/** POS-API-004. Items from the shop's own software, all or nothing. */
export async function pushItems(actor: Actor, raws: unknown) {
  mustManage(actor);
  await mustBeStandalone(actor.clientId);
  if (!Array.isArray(raws)) throw badRequest('Send { "items": [ ... ] }.');
  if (raws.length > 500) throw badRequest('At most 500 items per request. Send the rest in the next one.');
  const list = raws as Record<string, unknown>[];
  const checked = await checkAll(actor.clientId, list, 'api', i => `items[${i}]${list[i]?.code ? ` (${String(list[i].code)})` : ''}`);
  if (checked.problems.length) {
    throw badRequest(`Nothing was saved: ${checked.problems.length} item${checked.problems.length === 1 ? ' is' : 's are'} not right.`, { code: 'ITEMS_INVALID', problems: checked.problems });
  }
  await save(actor.clientId, checked.items);
  await record(actor, { action: 'items.imported', subject: 'API', detail: { added: checked.added, updated: checked.updated, unchanged: checked.unchanged } });
  return { added: checked.added, updated: checked.updated, unchanged: checked.unchanged, notes: checked.notes };
}

/** POS-API-005. Change one item's price, count, name or whether it is on sale. */
export async function patchItem(actor: Actor, code: string, input: Record<string, unknown>) {
  mustManage(actor);
  await mustBeStandalone(actor.clientId);
  const item = await prisma.item.findUnique({ where: { clientId_code: { clientId: actor.clientId, code } } });
  if (!item) throw notFound(`No item with code ${code}. Push it first with POST /items.`, { code: 'UNKNOWN_ITEM' });
  const allowed = ['pricePaise', 'qty', 'name', 'active'];
  const extra = Object.keys(input ?? {}).filter(k => !allowed.includes(k));
  if (extra.length) throw badRequest(`Only ${allowed.join(', ')} can be changed here. Not: ${extra.join(', ')}. Send the whole item to POST /items to change the rest.`);
  const merged = checkRow({
    code: item.code, name: input.name ?? item.name, pricePaise: input.pricePaise ?? item.pricePaise, taxRate: item.taxRate,
    hsn: item.hsn, barcode: item.barcode, qty: input.qty ?? null, active: input.active ?? item.active
  }, 'api');
  if (merged.problems.length) throw badRequest(`Not changed: ${merged.problems.join('; ')}.`, { code: 'ITEMS_INVALID', problems: merged.problems });
  const it = merged.item!;
  const saved = await prisma.item.update({
    where: { id: item.id },
    data: { name: it.name, pricePaise: it.pricePaise, active: it.active, ...(it.qty !== null ? { cachedQty: it.qty, cachedQtyAt: new Date() } : {}) }
  });
  return { code: saved.code, name: saved.name, pricePaise: saved.pricePaise, taxRate: saved.taxRate, qty: saved.cachedQty, active: saved.active };
}

/** The template the Import screen offers: the headings it understands, and one example row. */
export function templateCsv() {
  return '﻿code,name,price,gst,hsn,barcode,qty,colour,size,group\r\n'
    + 'SAR-001,Cotton saree,1299,5,5208,8901234500033,12,Maroon,Free,SAR-001\r\n';
}
