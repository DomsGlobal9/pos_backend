import { prisma } from '../../lib/prisma';
import { documentKindFor } from '../shop/gst-document';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { conflict, forbidden } from '../../utils/httpError';
import { record } from '../audit';
import { call } from './client';

/**
 * Filling the till's item list from Inventory. POS-INV-001, -002. Contract §2.
 *
 * The till never searches Inventory live: the sell screen reads its own `Item` table, so a slow
 * Inventory can never slow a scan (POS-INV-009). This copies Inventory's catalogue into that table
 * -- the whole of it the first time, then only what changed, from a cursor.
 *
 * Mapping, and the rules that come with it:
 *
 *   variantCode        -> Item.code        (the public identity; events send it back to Inventory)
 *   productCode        -> Item.variantGroup (so the sell screen offers colour and size together)
 *   pricePaise         -> Item.pricePaise   (integer paise, never a rupee float)
 *   taxRateBps         -> Item.taxRate      THE RATE AS THE SHOP TYPED IT, used as given. The POS
 *                                           stores whole percent today, so a fractional rate is not
 *                                           guessed at -- the item is skipped and named.
 *   priceIsExclusive   -> not sold          The POS prices inclusive; selling an exclusive price as
 *                                           if it were inclusive under-charges tax on every piece.
 *   taxSlabbed + over Rs 2,500 at 5%        WARNED, not corrected (contract §2).
 *   eligible:false     -> switched off      so the till stops selling what Inventory archived
 *   stock.available    -> Item.cachedQty    advisory, with the time it was read
 *
 * Every problem is kept, in words, for the owner's settings screen. None of it ever reaches a
 * cashier.
 */

const PAGE = 100;
const MAX_PAGES = 200;

export async function syncCatalogue(actor: Actor, opts: { full?: boolean } = {}) {
  if (!may(actor, PERMISSIONS.SETTINGS) && !may(actor, PERMISSIONS.CLOSE_DAY)) {
    throw forbidden('Only a manager or the owner can refresh the item list from Inventory.', { code: 'NOT_PERMITTED' });
  }
  return syncFor(actor.clientId, opts, actor);
}

/**
 * The sync itself, without the permission check, so the timer below can run it too.
 *
 * `actor` is only there to put a name against the audit line. The background pass has no person
 * behind it and records nothing -- an owner opening Activity should see the refreshes someone
 * chose to do, not one line every few minutes.
 */
async function syncFor(clientId: string, opts: { full?: boolean } = {}, actor?: Actor) {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId } });
  if (!link || !link.connected) throw conflict('This till is not connected to Inventory.', { code: 'NOT_CONNECTED' });

  let cursor = opts.full ? null : link.catalogueCursor;
  const problems: string[] = [];
  const counts = { added: 0, updated: 0, switchedOff: 0, skipped: 0 };

  /*
   * WHETHER THIS SHOP CHARGES GST AT ALL, which decides whether a missing rate is a data gap.
   *
   * Only a REGULAR registration charges GST and issues tax invoices. A COMPOSITION shop issues a
   * Bill of Supply and an UNREGISTERED one a plain receipt -- neither charges tax on anything, so
   * "no rate set in Inventory" is not something the owner has to go and fix, and holding the item
   * back would stop them selling for no reason (Inventory session, 6 Oct).
   *
   * Absent or null (never chosen): the till's own registration and GSTIN decide, by the same rule
   * as the bill (documentKindFor) -- and no GSTIN means no GST, whatever the registration says.
   */
  const own = await prisma.shopSettings.findUnique({ where: { clientId }, select: { gstRegistration: true, gstin: true } });
  let gstCharged = documentKindFor(own?.gstRegistration, own?.gstin) === 'TAX_INVOICE';
  /*
   * THE SHOP'S DISCOUNT LIMIT, from Inventory, as an explicit shape -- never a bare null. Inventory's
   * null means NO limit; our manualDiscountMaxPercent of 0 means nothing may be discounted without a
   * manager. They are opposites, and a null read into our Int column would silently invert the
   * owner's choice (contract §9). { unlimited: true } becomes 100; { maxPercent } is taken as is.
   */
  let manualDiscount: { maxPercent?: number; unlimited?: boolean } | null = null;
  // Inventory's return rule (9 Oct): whole days, or null for no limit. Absent: the till's own stays.
  let returnWindow: number | null | undefined = undefined;
  // The shop's GST registration, owned by Inventory's Settings while connected (it decides what a bill is).
  let registration: string | null = null;
  // The shop's logo as Inventory keeps it (Settings -> Name, logo and bill details), an https address.
  let inventoryLogo: string | null = null;
  // Whether Inventory said anything about the logo at all: an older Inventory sends no `shop` block,
  // and its silence must not wipe the logo the shop already has.
  let logoSaid = false;
  // The bill's shop details as Inventory keeps them (Settings -> Name, logo and bill details; address
  // and phone are this till's STORE's own when set). Only the keys Inventory actually sent.
  // Self-confirming UPI, the owner's switch in Inventory. undefined: Inventory did not say -- left alone.
  let upiQrEnabled: boolean | undefined;
  const details: { name?: unknown; address?: unknown; phone?: unknown; gstin?: unknown; receiptFooter?: unknown } = {};

  for (let page = 0; page < MAX_PAGES; page++) {
    // The cursor means "everything changed after this point" -- the same mechanism for the next page
    // of a first sync and for the next refresh days later (contract §2, the storefront's semantics).
    const q = `/catalogue?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const reply = await call(link, 'GET', q, undefined, 60_000);
    if (reply.kind === 'UNREACHABLE') {
      throw conflict(`Inventory could not be reached (${reply.reason}). The item list is unchanged; try again shortly.`, { code: 'UNREACHABLE' });
    }
    if (reply.status === 401 || reply.status === 403) {
      throw conflict('Inventory no longer accepts this till\'s key — it was replaced or disconnected. Make a new one in Inventory (Settings → Money → POS (billing counter)) and connect again.', { code: 'KEY_REFUSED' });
    }
    if (reply.status >= 400) {
      throw conflict(`Inventory answered with an error (${reply.status}). The item list is unchanged.`, { code: 'INVENTORY_ERROR' });
    }

    const data = reply.body?.data ?? {};
    if (data.gst?.registration) {
      const gstinNow = typeof data.shop?.gstin === 'string' && data.shop.gstin.trim() ? data.shop.gstin : own?.gstin;
      gstCharged = documentKindFor(data.gst.registration, gstinNow) === 'TAX_INVOICE';
    }
    if (['REGULAR', 'COMPOSITION', 'UNREGISTERED'].includes(data.gst?.registration)) registration = data.gst.registration;
    if (data.manualDiscount && typeof data.manualDiscount === 'object') manualDiscount = data.manualDiscount;
    if (data.returns && typeof data.returns === 'object' && 'windowDays' in data.returns) {
      const w = data.returns.windowDays;
      if (w === null) returnWindow = null;
      else if (Number.isInteger(w) && w >= 0 && w <= 3650) returnWindow = w;
    }
    if (data.shop && typeof data.shop === 'object' && 'logoUrl' in data.shop) {
      logoSaid = true;
      inventoryLogo = typeof data.shop.logoUrl === 'string' && /^https:\/\//.test(data.shop.logoUrl) ? data.shop.logoUrl : null;
    }
    if (data.upiQr && typeof data.upiQr === 'object') upiQrEnabled = data.upiQr.enabled === true;
    if (data.shop && typeof data.shop === 'object') {
      for (const key of ['name', 'address', 'phone', 'gstin', 'receiptFooter'] as const) {
        if (key in data.shop) details[key] = data.shop[key];
      }
    }
    const products: any[] = Array.isArray(data.products) ? data.products : [];
    for (const product of products) {
      await applyProduct(clientId, product, counts, problems, gstCharged);
    }
    cursor = data.nextCursor ?? cursor;
    if (!data.hasMore) break;
  }

  /*
   * THE PROBLEM LIST IS ONLY WRITTEN BY A PERSON'S REFRESH.
   *
   * These are the items an owner has to go and fix in Inventory -- priced before GST, a rate that
   * needs the accountant -- and they are the whole reason the list exists. The background pass is
   * INCREMENTAL: it asks only for what changed, so on a quiet shop it sees nothing and finds no
   * problems. Writing that empty list back wiped the owner's list three minutes after it appeared,
   * before anyone could read it (seen on sphl, 6 Oct, within 38 seconds of connecting).
   *
   * So a timed pass moves the cursor and the time, and leaves the list as the last deliberate look
   * found it -- which is what the screen says it is.
   *
   * ponytail: a problem that appears on an item changed between refreshes therefore waits for the
   * next manual refresh to be listed. Fixing that properly means tracking problems per item code
   * rather than as sentences; worth it only if owners start missing things.
   */
  const mine = await prisma.shopSettings.findUnique({ where: { clientId }, select: { gstin: true, logoUrl: true, gstRegistration: true } });
  /*
   * A SHOP WITH A GSTIN IS REGISTERED. Inventory answers UNREGISTERED when its owner never chose
   * (7 Oct), so taking that word for a shop whose bills carry a GSTIN would turn every bill into a
   * plain receipt with no GST -- tax the shop owes, uncollected. Only a GST-registered business has a
   * GSTIN, so the contradiction is the owner's to settle, and the till keeps issuing tax invoices.
   */
  if (registration === 'UNREGISTERED' && mine?.gstin) {
    problems.push(`Inventory says this shop is not GST registered, but its bills carry GSTIN ${mine.gstin}. A shop with a GSTIN is registered: choose GST registered or Composition in Inventory (Settings -> Name, logo and bill details). Bills stay tax invoices until then.`);
  } else if (registration) {
    await prisma.shopSettings.updateMany({ where: { clientId }, data: { gstRegistration: registration } });
  }
  /*
   * THE LOGO ON THE BILL COMES FROM INVENTORY while connected -- like the items, the prices and the
   * GST registration: one answer in one place (the owner, 7 Oct). Inventory's logo replaces whatever
   * the till had, and no logo there means no logo here. It shows on screen and on the printed bill;
   * the WhatsApp PDF carries a picture only when it is a JPEG.
   */
  if (logoSaid && inventoryLogo !== (mine?.logoUrl ?? null)) {
    await prisma.shopSettings.updateMany({ where: { clientId }, data: { logoUrl: inventoryLogo } });
  }
  /*
   * THE REST OF THE BILL'S HEADER COMES FROM INVENTORY TOO (7 Oct): name, address, phone, GSTIN and
   * footer, the same one source as the logo. What Inventory leaves empty: a bill must always name the
   * shop and say where it is, and a registered shop's tax invoice must carry its GSTIN -- so an empty
   * name, address or GSTIN keeps the till's and tells the owner what to fill in. An empty phone or
   * footer is simply none.
   */
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const header: { shopName?: string; address?: string; gstin?: string; phone?: string | null; receiptFooter?: string | null } = {};
  const fill = 'Fill it in Inventory (Settings -> Name, logo and bill details); the till keeps its own until then.';
  if ('name' in details) {
    const v = text(details.name, 120);
    if (v) header.shopName = v; else problems.push(`Inventory has no shop name for the bill. ${fill}`);
  }
  if ('address' in details) {
    const v = text(details.address, 300);
    if (v) header.address = v; else problems.push(`Inventory has no address for this store's bills. ${fill}`);
  }
  if ('gstin' in details) {
    const v = text(details.gstin, 20)?.replace(/\s+/g, '').toUpperCase() ?? null;
    if (v && /^[0-9]{2}[A-Z0-9]{13}$/.test(v)) header.gstin = v;
    else if (v) problems.push(`Inventory's GSTIN "${v}" is not 15 characters in the usual form, so the till kept its own. Check it in Inventory.`);
    else if ((registration ?? mine?.gstRegistration) === 'REGULAR' || (registration ?? mine?.gstRegistration) === 'COMPOSITION') {
      problems.push(`Inventory has no GSTIN saved for this registered shop. ${fill}`);
    }
  }
  if ('phone' in details) header.phone = text(details.phone, 40);
  if ('receiptFooter' in details) header.receiptFooter = text(details.receiptFooter, 300);
  if (Object.keys(header).length) await prisma.shopSettings.updateMany({ where: { clientId }, data: header });
  if (upiQrEnabled !== undefined) await prisma.shopSettings.updateMany({ where: { clientId }, data: { upiQrEnabled } });
  if (returnWindow !== undefined) await prisma.shopSettings.updateMany({ where: { clientId }, data: { returnWindowDays: returnWindow } });
  if (manualDiscount) {
    const percent = manualDiscount.unlimited === true ? 100 : Number(manualDiscount.maxPercent);
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      await prisma.shopSettings.updateMany({ where: { clientId }, data: { manualDiscountMaxPercent: Math.round(percent) } });
    }
  }
  await prisma.inventoryLink.update({
    where: { clientId },
    data: {
      catalogueCursor: cursor,
      catalogueSyncedAt: new Date(),
      ...(actor ? { catalogueProblems: problems } : {})
    }
  });
  if (actor) await record(actor, { action: 'inventory.catalogue_synced', detail: { ...counts, problems: problems.length } });
  return { ...counts, problems };
}

/*
 * KEEPING STOCK IN STEP WITHOUT ANYONE PRESSING ANYTHING.
 *
 * The till sells from its own copy of the item list, which is what keeps a scan fast. Until now
 * that copy only moved when a manager pressed "Refresh items from Inventory" -- so if the online
 * shop or a second till sold the last piece, this one went on offering it until somebody thought
 * to press the button. The sale is still recorded and Inventory still takes it (stock simply goes
 * negative, with a warning), but the customer has been promised something that is not there.
 *
 * The cursor makes this cheap: each pass asks only for what changed since the last one, which is
 * usually nothing and costs one request per shop. The button stays -- a manager who has just
 * corrected a count in Inventory wants it now, not in three minutes.
 */
const EVERY_MS = 3 * 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startCatalogueLoop(everyMs = EVERY_MS) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const links = await prisma.inventoryLink.findMany({ where: { connected: true }, select: { clientId: true } });
      for (const l of links) {
        // Per shop, so one shop's bad key or slow answer never stops the others.
        try { await syncFor(l.clientId); }
        catch (error) { console.error(`[inventory-link] catalogue refresh for ${l.clientId} failed:`, (error as Error).message); }
      }
    } catch (error) {
      // The list of shops is one query outside the per-shop catch, and a dropped pooler connection
      // here took the whole server down once before (30 Sep). The next pass simply tries again.
      console.error('[inventory-link] catalogue pass failed:', (error as Error).message);
    } finally { running = false; }
  }, everyMs);
  timer.unref();
}

async function applyProduct(clientId: string, product: any, counts: Record<string, number>, problems: string[], gstCharged = true) {
  const title = String(product.title ?? '').trim() || product.productCode;
  const primary = (product.images ?? []).find((i: any) => i.isPrimary)?.url ?? product.images?.[0]?.url ?? null;
  const productOff = product.eligible === false;

  for (const v of product.variants ?? []) {
    const code = String(v.variantCode ?? '').trim();
    if (!code) { counts.skipped++; problems.push(`${title}: a variant with no code was skipped.`); continue; }
    const label = [title, v.colour, v.size].filter(Boolean).join(', ');
    const existing = await prisma.item.findUnique({ where: { clientId_code: { clientId, code } }, select: { id: true, active: true } });

    // Archived or unpublished in Inventory: stop selling it here.
    if (productOff || v.eligible === false) {
      if (existing?.active) {
        await prisma.item.update({ where: { id: existing.id }, data: { active: false } });
        counts.switchedOff++;
      }
      continue;
    }

    /*
     * NO RATE AT ALL is not a rate of nothing.
     *
     * Number(null) is 0, and 0 passes every check below -- a whole number, not negative, a whole
     * percent -- so a variant with no GST rate set in Inventory was taken at 0% and sold at 0% in a
     * GST-registered shop, silently, with nothing on the owner's list to say so (found on sphl by
     * the Inventory session, 6 Oct: two sarees, one at Rs 29,500).
     *
     * A deliberate 0 still sells: zero-rated goods are real. It is the ABSENCE that is a data gap,
     * and the contract already says so -- "a null taxRateBps is a data gap for the owner to fill in
     * Inventory, not something to guess".
     *
     * In a shop that charges no GST there is no gap to fill, so the absence is taken as the 0 it
     * effectively is and the item sells.
     */
    /*
     * GST IS OPTIONAL (7 Oct): a missing rate never stops an item selling. In a shop that charges GST
     * it sells at 0% and the owner gets a quiet line to set the rate; anywhere else there is nothing
     * to set.
     */
    const noRate = v.taxRateBps === null || v.taxRateBps === undefined || v.taxRateBps === '';
    if (gstCharged && noRate) {
      problems.push(`${label} (${code}): no GST rate in Inventory, so it sells at 0% GST. Set the rate there if it should carry GST.`);
    }
    const bps = noRate ? 0 : Number(v.taxRateBps);
    if (!Number.isInteger(bps) || bps < 0 || bps % 100 !== 0) {
      counts.skipped++;
      problems.push(`${label} (${code}): GST ${Number.isFinite(bps) ? bps / 100 : '?'}% is not a whole percent — not taken until the till supports it.`);
      continue;
    }
    const pricePaise = Number(v.pricePaise);
    if (!Number.isInteger(pricePaise) || pricePaise <= 0) {
      counts.skipped++;
      problems.push(`${label} (${code}): no usable price.`);
      continue;
    }
    const exclusive = v.priceIsExclusive === true;
    if (exclusive) problems.push(`${label} (${code}): priced before GST in Inventory — not sold at the till until it is priced including GST.`);
    if (v.taxSlabbed && pricePaise > 250_000 && bps === 500) {
      problems.push(`${label} (${code}): stitched and over Rs 2,500 but set to 5% GST. Check the rate with the accountant.`);
    }

    // A barcode already on another item here cannot be taken twice; keep the item, drop the barcode.
    let barcode: string | null = v.barcode ? String(v.barcode) : null;
    if (barcode) {
      const clash = await prisma.item.findFirst({ where: { clientId, barcode, NOT: { code } }, select: { code: true } });
      if (clash) {
        problems.push(`${label} (${code}): barcode ${barcode} is already on ${clash.code} — left off this item.`);
        barcode = null;
      }
    }

    // A service has no stock: null, which Number() would make 0 -- "none left" on fall & pico (10 Oct).
    const available = v.stock?.available === null ? NaN : Number(v.stock?.available);
    const data = {
      name: title,
      colour: v.colour ?? null,
      size: v.size ?? null,
      hsn: v.hsn ?? null,
      pricePaise,
      taxRate: bps / 100,
      barcode,
      imageUrl: primary,
      variantGroup: product.productCode ?? null,
      // Marks the row as Inventory's. The public identity is `code`; see the Item model.
      inventoryVariantId: code,
      cachedQty: Number.isFinite(available) ? available : null,
      cachedQtyAt: new Date(),
      active: !exclusive
    };

    if (existing) {
      await prisma.item.update({ where: { id: existing.id }, data });
      counts.updated++;
    } else {
      await prisma.item.create({ data: { clientId, code, ...data } });
      counts.added++;
    }
  }
}
