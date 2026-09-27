import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, forbidden, notFound } from '../../utils/httpError';
import { seal } from '../../utils/credential';
import { record } from '../audit';

/**
 * A shop's own software, told when something happens. POS-WEB-001, -006.
 *
 * The owner adds an address ("https://tally-bridge.example.com/pos"), chooses which events, and is
 * shown a signing secret ONCE. Every notice to that address is signed with it (sign.ts), numbered
 * (`sequence`, so a receiver can put them in order), versioned, and retried until it lands or eight
 * tries have failed -- then kept, and re-sendable by hand from the delivery history.
 *
 * The events a shop can choose. `ping` is the Test button and is never subscribed to.
 */
export const EVENT_TYPES = ['sale.completed', 'sale.returned', 'sale.exchanged', 'day.closed'] as const;

type Tx = Prisma.TransactionClient;

function mustManage(actor: Actor) {
  if (!may(actor, PERMISSIONS.INTEGRATIONS)) {
    throw forbidden('Only the owner can manage connections to other software.', { code: 'NOT_PERMITTED' });
  }
}

/** Private, loopback and link-local addresses -- our own network, which a webhook must never reach. */
function isPrivate(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

/**
 * Is this an address we may send a shop's data to?
 *
 * In production: https only, and a host that resolves to the public internet. An address inside our
 * own network (the cloud's metadata service at 169.254.169.254, a database on 10.x) would turn the
 * webhook sender into a way of reading our infrastructure. Checked when the address is saved AND
 * before each send, because DNS can change in between. Local development may use http://localhost.
 */
export async function checkAddress(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw badRequest('That is not a web address. It should look like https://your-software.example.com/pos-events'); }
  if (url.username || url.password) throw badRequest('Leave the user name and password out of the address.');
  const production = env.NODE_ENV === 'production';
  if (production && url.protocol !== 'https:') throw badRequest('The address must start with https:// so the shop\'s sales are not sent in the clear.');
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('The address must start with https://');
  if (production) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
    if (ips.length === 0) throw badRequest(`${url.hostname} could not be found. Check the address.`);
    if (ips.some(isPrivate)) throw badRequest('That address is inside a private network. Use the public address of your software.');
  }
  return url;
}

const view = (e: any) => ({
  id: e.id, name: e.name, url: e.url, secretPrefix: e.secretPrefix, events: e.events, active: e.active,
  lastDeliveryAt: e.lastDeliveryAt, failingSince: e.failingSince, createdAt: e.createdAt
});

function cleanEvents(events: string[] | undefined) {
  const list = [...new Set(events ?? [])];
  const unknown = list.filter(e => !(EVENT_TYPES as readonly string[]).includes(e));
  if (unknown.length) throw badRequest(`Not an event the POS sends: ${unknown.join(', ')}.`);
  return list; // empty = all of them
}

export async function create(actor: Actor, input: { name?: string; url?: string; events?: string[] }) {
  mustManage(actor);
  const name = (input.name ?? '').trim();
  if (name.length < 2) throw badRequest('Name it after the software it goes to -- "Tally bridge", "Website".');
  const url = await checkAddress(input.url ?? '');
  const events = cleanEvents(input.events);
  const secret = 'whsec_' + crypto.randomBytes(32).toString('base64url');
  const row = await prisma.webhookEndpoint.create({
    data: { clientId: actor.clientId, name: name.slice(0, 60), url: url.toString(), secretCipher: seal(secret), secretPrefix: secret.slice(0, 12), events }
  });
  await record(actor, { action: 'webhook.created', subject: row.name, detail: { url: row.url, events } });
  return { secret, endpoint: view(row) };
}

export async function update(actor: Actor, id: string, input: { name?: string; url?: string; events?: string[]; active?: boolean }) {
  mustManage(actor);
  const row = await prisma.webhookEndpoint.findFirst({ where: { id, clientId: actor.clientId } });
  if (!row) throw notFound('That connection was not found.');
  const data: Prisma.WebhookEndpointUpdateInput = {};
  if (input.name !== undefined) {
    if (input.name.trim().length < 2) throw badRequest('Give it a name people will recognise.');
    data.name = input.name.trim().slice(0, 60);
  }
  if (input.url !== undefined) data.url = (await checkAddress(input.url)).toString();
  if (input.events !== undefined) data.events = cleanEvents(input.events);
  if (input.active !== undefined) data.active = input.active;
  const done = await prisma.webhookEndpoint.update({ where: { id }, data });
  await record(actor, { action: 'webhook.updated', subject: done.name, detail: { ...input } as Prisma.InputJsonValue });
  return view(done);
}

/** Removed with its history. Notices already on their way are dropped with it. */
export async function remove(actor: Actor, id: string) {
  mustManage(actor);
  const row = await prisma.webhookEndpoint.findFirst({ where: { id, clientId: actor.clientId } });
  if (!row) throw notFound('That connection was not found.');
  await prisma.webhookEndpoint.delete({ where: { id } });
  await record(actor, { action: 'webhook.deleted', subject: row.name, detail: { url: row.url } });
  return { removed: true };
}

export async function list(actor: Actor) {
  mustManage(actor);
  const rows = await prisma.webhookEndpoint.findMany({ where: { clientId: actor.clientId }, orderBy: { createdAt: 'desc' } });
  const counts = await prisma.webhookDelivery.groupBy({
    by: ['endpointId', 'status'], where: { clientId: actor.clientId, endpointId: { in: rows.map(r => r.id) } }, _count: true
  });
  return rows.map(r => {
    const of = (s: string) => counts.find(c => c.endpointId === r.id && c.status === s)?._count ?? 0;
    return { ...view(r), waiting: of('PENDING') + of('DELIVERING'), failed: of('FAILED'), delivered: of('DELIVERED') };
  });
}

/** What happened to each notice, newest first. POS-WEB-006. */
export async function deliveries(actor: Actor, endpointId: string, take = 50) {
  mustManage(actor);
  const row = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, clientId: actor.clientId }, select: { id: true } });
  if (!row) throw notFound('That connection was not found.');
  const rows = await prisma.webhookDelivery.findMany({
    where: { endpointId, clientId: actor.clientId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(take, 1), 200),
    include: { event: { select: { sequence: true, eventType: true, invoiceNo: true, createdAt: true } } }
  });
  return rows.map(d => ({
    id: d.id,
    sequence: d.event.sequence.toString(),
    eventType: d.event.eventType,
    document: d.event.invoiceNo,
    status: d.status,
    attempts: d.attempts,
    lastAttemptAt: d.lastAttemptAt,
    nextAttemptAt: d.status === 'PENDING' ? d.nextAttemptAt : null,
    deliveredAt: d.deliveredAt,
    /** In words, for the owner; the code in brackets is for whoever runs the other software. */
    outcome: outcomeText(d.status, d.responseCode, d.responseBody),
    responseCode: d.responseCode
  }));
}

function outcomeText(status: string, code: number | null, body: string | null) {
  if (status === 'DELIVERED') return 'Received.';
  const why = code === null
    ? (body ? `Could not reach it (${body}).` : 'Not sent yet.')
    : `Their software answered with an error (${code}).`;
  if (status === 'FAILED') return `${why} Gave up after 8 tries -- send it again once their software is fixed.`;
  return why;
}

/** Send a failed (or any) notice again, now. POS-WEB-006. */
export async function resend(actor: Actor, deliveryId: string) {
  mustManage(actor);
  const d = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId, clientId: actor.clientId }, include: { endpoint: { select: { name: true } } } });
  if (!d) throw notFound('That notice was not found.');
  await prisma.webhookDelivery.update({
    where: { id: d.id },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lockedAt: null }
  });
  await record(actor, { action: 'webhook.resent', subject: d.endpoint.name, detail: { deliveryId } });
  return { queued: true };
}

/**
 * Everything the shop's software asked for, queued in the SAME transaction as the event.
 * An endpoint added later does not receive the past; one switched off receives nothing.
 */
export async function fanOut(tx: Tx, clientId: string, eventId: string, eventType: string) {
  await tx.$executeRaw`
    INSERT INTO webhook_deliveries (id, event_id, endpoint_id, client_id, status, attempts, next_attempt_at, created_at)
    SELECT gen_random_uuid()::text, ${eventId}, e.id, e.client_id, 'PENDING', 0, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
      FROM webhook_endpoints e
     WHERE e.client_id = ${clientId}
       AND e.active
       AND (cardinality(e.events) = 0 OR ${eventType} = ANY(e.events))
    ON CONFLICT (event_id, endpoint_id) DO NOTHING`;
}
