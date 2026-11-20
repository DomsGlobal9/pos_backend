import { prisma } from '../../lib/prisma';
import { Actor, holdsEverything } from '../../types/actor';
import { call } from '../inventory-link/client';
import { record } from '../audit';
import { badRequest, forbidden, notFound } from '../../utils/httpError';
import { MODULE, SERVICE_SCOPES } from './constants';

/**
 * WHICH BOUTIQUE IS THIS SHOP (20 Nov). Nobody types it: Inventory already knows which Boutique app account
 * (tenant) is linked to which Inventory shop, and says so to that shop's own till over the link the till
 * already has (GET /pos/v1/boutique-link -> { tenant, linkedAt, active }). A till only ever learns its own
 * shop's answer. POS keeps "tenant -> this shop", with the Boutique app's own counter and drawer.
 *
 * Asked for every connected shop now and then, and again soon after a pass names a boutique POS does not
 * know yet (a boutique that linked a minute ago).
 */

export const BOUTIQUE_COUNTER = 'Boutique counter';
const EVERY_MS = 15 * 60_000;
const SOON_MS = 60_000;

export type Learned = 'LINKED' | 'UNCHANGED' | 'UNLINKED' | 'NONE' | 'NOT_CONNECTED' | 'NO_ANSWER';

/** One shop: what Inventory says, kept here. */
export async function learnFor(clientId: string): Promise<Learned> {
  const inv = await prisma.inventoryLink.findUnique({ where: { clientId }, select: { connected: true, baseUrl: true, keyCipher: true } });
  if (!inv?.connected) return 'NOT_CONNECTED';
  const reply = await call(inv, 'GET', '/boutique-link');
  if (reply.kind !== 'ANSWERED' || reply.status !== 200) return 'NO_ANSWER';
  const data = reply.body?.data ?? reply.body ?? {};
  const tenant = typeof data.tenant === 'string' && data.tenant.trim() ? data.tenant.trim().toLowerCase() : null;
  const existing = await prisma.moduleLink.findUnique({ where: { clientId_module: { clientId, module: MODULE } } });

  if (!tenant || data.active === false) {
    if (existing?.active) {
      await prisma.moduleLink.update({ where: { id: existing.id }, data: { active: false } });
      return 'UNLINKED';
    }
    return 'NONE';
  }
  if (existing && existing.tenant === tenant && existing.active) return 'UNCHANGED';

  // The tenant is one boutique's, everywhere: if another shop held it before (Inventory moved it), that row ends.
  await prisma.$transaction(async tx => {
    await tx.moduleLink.updateMany({ where: { module: MODULE, tenant, clientId: { not: clientId } }, data: { active: false, tenant: `moved:${Date.now()}:${tenant}`.slice(0, 200) } });
    const counter = await tx.counter.upsert({
      where: { clientId_name: { clientId, name: BOUTIQUE_COUNTER } },
      update: { active: true },
      create: { clientId, name: BOUTIQUE_COUNTER }
    });
    if (existing) {
      await tx.moduleLink.update({ where: { id: existing.id }, data: { tenant, active: true, counterId: existing.counterId ?? counter.id } });
    } else {
      await tx.moduleLink.create({ data: { clientId, module: MODULE, tenant, scopes: [...SERVICE_SCOPES], counterId: counter.id, createdBy: 'Inventory' } });
    }
  });
  await record({ kind: 'SYSTEM', clientId, id: null, name: 'ScaleEzy POS', roles: [], permissions: [] },
    { action: 'module.linked', subject: tenant, detail: { module: MODULE, by: 'Inventory' } });
  return 'LINKED';
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let soon: NodeJS.Timeout | null = null;

async function pass() {
  if (running) return;
  running = true;
  try {
    const shops = await prisma.inventoryLink.findMany({ where: { connected: true }, select: { clientId: true } });
    for (const s of shops) {
      try { await learnFor(s.clientId); } catch (e) { console.error(`[service] boutique link for ${s.clientId}:`, (e as Error).message); }
    }
  } finally { running = false; }
}

/** A pass named a boutique POS does not know: ask Inventory again shortly (once, however many calls). */
export function askSoon() {
  if (soon) return;
  soon = setTimeout(() => { soon = null; pass().catch(() => {}); }, SOON_MS);
  soon.unref?.();
}

export function startModuleLinkLoop(everyMs = EVERY_MS) {
  if (timer) return;
  setTimeout(() => pass().catch(() => {}), 20_000).unref?.();
  timer = setInterval(() => pass().catch(() => {}), everyMs);
  timer.unref?.();
}

/* ---- The owner's view: the Boutique app at this shop, and what it may do -------------------------- */

const view = (l: { tenant: string; scopes: string[]; active: boolean; paused: boolean; lastCallAt: Date | null; createdAt: Date; counter: { name: string } }) =>
  ({ module: MODULE, tenant: l.tenant, scopes: l.scopes, active: l.active && !l.paused, paused: l.paused, counter: l.counter.name, lastCallAt: l.lastCallAt, since: l.createdAt });

export async function moduleLinks(actor: Actor) {
  const rows = await prisma.moduleLink.findMany({ where: { clientId: actor.clientId }, include: { counter: { select: { name: true } } } });
  return { scopes: SERVICE_SCOPES, links: rows.map(view) };
}

/** The owner narrows (or widens again) what the Boutique app may do here, or pauses it. */
export async function changeModuleLink(actor: Actor, input: { scopes?: string[]; active?: boolean }) {
  if (!holdsEverything(actor)) throw forbidden('Only the owner can change what another app may do here.', { code: 'NOT_PERMITTED' });
  const link = await prisma.moduleLink.findUnique({ where: { clientId_module: { clientId: actor.clientId, module: MODULE } } });
  if (!link) throw notFound('No Boutique app is linked to this shop.');
  const scopes = input.scopes ? [...new Set(input.scopes)] : undefined;
  if (scopes?.some(s => !(SERVICE_SCOPES as readonly string[]).includes(s))) throw badRequest('That is not something the Boutique app can be allowed.');
  const row = await prisma.moduleLink.update({
    where: { id: link.id },
    data: { ...(scopes ? { scopes } : {}), ...(input.active === undefined ? {} : { paused: !input.active }) },
    include: { counter: { select: { name: true } } }
  });
  await record(actor, { action: 'module.changed', subject: row.tenant, detail: { module: MODULE, scopes: row.scopes, paused: row.paused } });
  return view(row);
}
