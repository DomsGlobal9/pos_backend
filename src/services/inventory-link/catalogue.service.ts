import { prisma } from '../../lib/prisma';
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
  const link = await prisma.inventoryLink.findUnique({ where: { clientId: actor.clientId } });
  if (!link || !link.connected) throw conflict('This till is not connected to Inventory.', { code: 'NOT_CONNECTED' });

  let cursor = opts.full ? null : link.catalogueCursor;
  const problems: string[] = [];
  const counts = { added: 0, updated: 0, switchedOff: 0, skipped: 0 };

  for (let page = 0; page < MAX_PAGES; page++) {
    // The cursor means "everything changed after this point" -- the same mechanism for the next page
    // of a first sync and for the next refresh days later (contract §2, the storefront's semantics).
    const q = `/pos/catalogue?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const reply = await call(link, 'GET', q, undefined, 20_000);
    if (reply.kind === 'UNREACHABLE') {
      throw conflict(`Inventory could not be reached (${reply.reason}). The item list is unchanged; try again shortly.`, { code: 'UNREACHABLE' });
    }
    if (reply.status === 401 || reply.status === 403) {
      throw conflict('Inventory no longer accepts this till\'s key. Connect again with a new key.', { code: 'KEY_REFUSED' });
    }
    if (reply.status >= 400) {
      throw conflict(`Inventory answered with an error (${reply.status}). The item list is unchanged.`, { code: 'INVENTORY_ERROR' });
    }

    const data = reply.body?.data ?? {};
    const products: any[] = Array.isArray(data.products) ? data.products : [];
    for (const product of products) {
      await applyProduct(actor.clientId, product, counts, problems);
    }
    cursor = data.nextCursor ?? cursor;
    if (!data.hasMore) break;
  }

  await prisma.inventoryLink.update({
    where: { clientId: actor.clientId },
    data: { catalogueCursor: cursor, catalogueSyncedAt: new Date(), catalogueProblems: problems }
  });
  await record(actor, { action: 'inventory.catalogue_synced', detail: { ...counts, problems: problems.length } });
  return { ...counts, problems };
}

async function applyProduct(clientId: string, product: any, counts: Record<string, number>, problems: string[]) {
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

    const bps = Number(v.taxRateBps);
    if (!Number.isInteger(bps) || bps < 0 || bps % 100 !== 0) {
      counts.skipped++;
      problems.push(`${label} (${code}): GST ${Number.isFinite(bps) ? bps / 100 : '?'}% is not a whole percent -- not taken until the till supports it.`);
      continue;
    }
    const pricePaise = Number(v.pricePaise);
    if (!Number.isInteger(pricePaise) || pricePaise <= 0) {
      counts.skipped++;
      problems.push(`${label} (${code}): no usable price.`);
      continue;
    }
    const exclusive = v.priceIsExclusive === true;
    if (exclusive) problems.push(`${label} (${code}): priced before GST in Inventory -- not sold at the till until it is priced including GST.`);
    if (v.taxSlabbed && pricePaise > 250_000 && bps === 500) {
      problems.push(`${label} (${code}): stitched and over Rs 2,500 but set to 5% GST. Check the rate with the accountant.`);
    }

    // A barcode already on another item here cannot be taken twice; keep the item, drop the barcode.
    let barcode: string | null = v.barcode ? String(v.barcode) : null;
    if (barcode) {
      const clash = await prisma.item.findFirst({ where: { clientId, barcode, NOT: { code } }, select: { code: true } });
      if (clash) {
        problems.push(`${label} (${code}): barcode ${barcode} is already on ${clash.code} -- left off this item.`);
        barcode = null;
      }
    }

    const available = Number(v.stock?.available);
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
