import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, forbidden, notFound, unauthorized } from '../../utils/httpError';
import { record } from '../audit';

/**
 * Keys a shop's own software uses to call the POS. POS-API-001.
 *
 * The owner makes a key, names it ("Tally sync", "Website"), picks what it may do, and sees it
 * ONCE. After that only its first characters are shown. We keep a SHA-256 of it: a key is 32
 * random bytes, so a hash is enough to check it and worthless to anyone who reads the table.
 *
 * WHAT A KEY MAY DO is a short list of scopes, strings on the row -- never a database enum (adding a
 * value to a shared enum took Inventory's alerts bell down on 23 Sep):
 *
 *   sales:read       bills by date, one bill by number              POS-API-002, -003
 *   items:write      push items, change a price or a count          POS-API-004, -005
 *   customers:read   find a customer by phone                       POS-API-006
 *   day:read         a day's figures, for the accountant's software POS-API-007
 *
 * A key never acts as a person: it cannot give a discount, override a price at the till or approve
 * anything. It is an Actor of kind API_KEY holding only its scopes.
 */

export const SCOPES = ['sales:read', 'items:write', 'customers:read', 'day:read'] as const;
export type Scope = (typeof SCOPES)[number];

const PREFIX = 'pos_live_';
const hash = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

function mustManage(actor: Actor) {
  if (!may(actor, PERMISSIONS.INTEGRATIONS)) {
    throw forbidden('Only the owner can manage connections to other software.', { code: 'NOT_PERMITTED' });
  }
}

const view = (k: { id: string; name: string; keyPrefix: string; scopes: string[]; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date }) => ({
  id: k.id, name: k.name, keyPrefix: k.keyPrefix, scopes: k.scopes,
  lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, createdAt: k.createdAt
});

/** Make a key. The only time the whole key is ever returned. */
export async function create(actor: Actor, input: { name?: string; scopes?: string[] }) {
  mustManage(actor);
  const name = (input.name ?? '').trim();
  if (name.length < 2) throw badRequest('Name the key after the software that will use it -- "Tally sync", "Website".');
  const scopes = [...new Set(input.scopes ?? [])];
  if (scopes.length === 0) throw badRequest('Choose at least one thing this key may do.');
  const unknown = scopes.filter(s => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw badRequest(`Not something a key can be allowed: ${unknown.join(', ')}.`);

  const key = PREFIX + crypto.randomBytes(32).toString('base64url');
  const row = await prisma.apiKey.create({
    data: {
      clientId: actor.clientId, name: name.slice(0, 60), keyHash: hash(key), keyPrefix: key.slice(0, PREFIX.length + 6),
      scopes, createdBy: actor.name ?? null
    }
  });
  await record(actor, { action: 'api_key.created', subject: row.name, detail: { keyPrefix: row.keyPrefix, scopes } });
  return { key, apiKey: view(row) };
}

export async function list(actor: Actor) {
  mustManage(actor);
  const rows = await prisma.apiKey.findMany({ where: { clientId: actor.clientId }, orderBy: { createdAt: 'desc' } });
  return rows.map(view);
}

/** Stop a key working, at once. Kept (revoked) so the audit trail still names it. */
export async function revoke(actor: Actor, id: string) {
  mustManage(actor);
  const row = await prisma.apiKey.findFirst({ where: { id, clientId: actor.clientId } });
  if (!row) throw notFound('That key was not found.');
  if (row.revokedAt) return view(row);
  const done = await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  await record(actor, { action: 'api_key.revoked', subject: row.name, detail: { keyPrefix: row.keyPrefix } });
  return view(done);
}

/**
 * The key on a request, as an Actor -- or a refusal a developer can act on. Every failure says the
 * same thing: which key it was is not something to confirm to whoever is guessing.
 */
export async function authenticate(raw: string | undefined): Promise<Actor> {
  const key = (raw ?? '').trim();
  if (!key.startsWith(PREFIX) || key.length < PREFIX.length + 20) {
    throw unauthorized('Send your POS API key as "Authorization: Bearer pos_live_...".', { code: 'NO_KEY' });
  }
  const row = await prisma.apiKey.findUnique({ where: { keyHash: hash(key) } });
  if (!row || row.revokedAt) {
    throw unauthorized('This API key is not valid. It may have been revoked -- ask the shop owner for a new one.', { code: 'BAD_KEY' });
  }
  // Last used, at most once a minute: a busy integration must not turn every read into a write.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return {
    kind: 'API_KEY', clientId: row.clientId, id: row.id, name: `API key "${row.name}"`,
    roles: [], permissions: row.scopes.map(s => `api:${s}`)
  };
}

/** Refuse a key that was not given this scope, naming the scope. */
export function mustHaveScope(actor: Actor, scope: Scope) {
  if (actor.kind !== 'API_KEY' || !actor.permissions.includes(`api:${scope}`)) {
    throw forbidden(`This key is not allowed "${scope}". The shop owner can make a key that is.`, { code: 'SCOPE_MISSING', scope });
  }
}
