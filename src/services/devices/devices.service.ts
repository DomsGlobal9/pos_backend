import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, forbidden, notFound } from '../../utils/httpError';
import { record } from '../audit';

/**
 * The devices the till runs on. WF-DEVICES-01, POS-DEV-001..004.
 *
 * A device registers ITSELF: the browser keeps a random id in local storage and checks in when the
 * till opens and every minute after. Nobody types serial numbers. The owner sees what is in use,
 * at which counter, on which version, and when each was last seen -- "Counter 2's tablet has not
 * been seen since Tuesday" is the question this answers.
 *
 * WHAT A BROWSER CANNOT KNOW is said as that. It cannot see a printer's paper or whether it is
 * switched on, so "printer" here means what the till prints to (the paper width it lays the receipt
 * out for) and when it last printed. Claiming more would be a status light that lies.
 */

const ONLINE_MS = 3 * 60_000;

export interface Heartbeat {
  deviceId: string;
  name?: string;
  appVersion?: string;
  userAgent?: string;
  capabilities?: { camera?: boolean; cameraScan?: boolean; touch?: boolean; screen?: string };
  printed?: boolean;
  /** Sales waiting on this device to be sent. */
  pending?: { count: number; oldestAt?: string | null };
}

/** POS-DEV-001, -004. Register on first sight; afterwards, just "still here". */
export async function heartbeat(actor: Actor, input: Heartbeat) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.deviceId ?? '')) throw badRequest('This device has no usable id.');
  const existing = await prisma.device.findUnique({ where: { id: input.deviceId }, select: { clientId: true } });
  // A device id belongs to the shop that first registered it. Another shop presenting it is a
  // copied browser profile, not a device moving shops.
  if (existing && existing.clientId !== actor.clientId) throw forbidden('This device is registered to another shop.');

  const data = {
    appVersion: input.appVersion?.slice(0, 40) ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    capabilities: input.capabilities ?? undefined,
    lastSeenAt: new Date(),
    lastUserName: actor.name ?? null,
    ...(input.printed ? { lastPrintedAt: new Date() } : {}),
    ...(input.pending ? {
      pendingCount: Math.max(0, Math.floor(input.pending.count || 0)),
      pendingOldestAt: input.pending.count > 0 && input.pending.oldestAt ? new Date(input.pending.oldestAt) : null
    } : {})
  };
  const row = await prisma.device.upsert({
    where: { id: input.deviceId },
    create: { id: input.deviceId, clientId: actor.clientId, name: (input.name ?? 'New device').slice(0, 60), ...data },
    update: data
  });
  return view(row);
}

/** POS-DEV-001..004. Every device, most recently seen first. */
export async function list(actor: Actor) {
  const rows = await prisma.device.findMany({
    where: { clientId: actor.clientId },
    orderBy: { lastSeenAt: 'desc' },
    include: { counter: { select: { id: true, name: true } } }
  });
  return { mayManage: may(actor, PERMISSIONS.SETTINGS) || may(actor, PERMISSIONS.CLOSE_DAY), devices: rows.map(view) };
}

/** Rename, put at a counter, choose the paper. Manager or owner. */
export async function update(actor: Actor, deviceId: string, input: { name?: string; counterId?: string | null; paperWidthMm?: number }) {
  if (!may(actor, PERMISSIONS.SETTINGS) && !may(actor, PERMISSIONS.CLOSE_DAY)) {
    throw forbidden('Only a manager or the owner can change a device.');
  }
  const device = await prisma.device.findFirst({ where: { id: deviceId, clientId: actor.clientId } });
  if (!device) throw notFound('That device was not found.');
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2) throw badRequest('Give the device a name people will recognise — "Counter 1 PC", "Ravi\'s phone".');
    data.name = name.slice(0, 60);
  }
  if (input.counterId !== undefined) {
    if (input.counterId) {
      const counter = await prisma.counter.findFirst({ where: { id: input.counterId, clientId: actor.clientId }, select: { id: true } });
      if (!counter) throw notFound('That counter was not found.');
    }
    data.counterId = input.counterId;
  }
  if (input.paperWidthMm !== undefined) {
    if (![58, 80].includes(input.paperWidthMm)) throw badRequest('Receipt paper is 58 mm or 80 mm wide.');
    data.paperWidthMm = input.paperWidthMm;
  }
  const row = await prisma.device.update({ where: { id: deviceId }, data, include: { counter: { select: { id: true, name: true } } } });
  await record(actor, { action: 'device.updated', subject: row.name, detail: data as any });
  return view(row);
}

function view(row: any) {
  const seen = new Date(row.lastSeenAt).getTime();
  return {
    id: row.id,
    name: row.name,
    counter: row.counter ? { id: row.counter.id, name: row.counter.name } : null,
    appVersion: row.appVersion,
    userAgent: row.userAgent,
    capabilities: row.capabilities ?? {},
    paperWidthMm: row.paperWidthMm,
    lastSeenAt: row.lastSeenAt,
    lastUserName: row.lastUserName,
    lastPrintedAt: row.lastPrintedAt,
    pendingCount: row.pendingCount ?? 0,
    pendingOldestAt: row.pendingOldestAt ?? null,
    online: Date.now() - seen < ONLINE_MS
  };
}
