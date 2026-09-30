import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Actor, holdsEverything, may, PERMISSIONS } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { hashPassword } from '../auth';
import { record } from '../audit';

/**
 * The people who work the till. POS-CORE-002, POS-SET-008. Owner only (settings:manage).
 *
 * Each person has a role (Owner, Manager, Cashier) and a 4-digit PIN -- the PIN puts them at the till
 * and, for a manager, approves a discount. Owners and managers may also have a password, which is
 * what opens the till on a device in the morning. A cashier does not need one.
 *
 * Removing someone keeps them (suspended): their name stays on every bill they made.
 */

export const ROLES = ['OWNER', 'MANAGER', 'CASHIER'] as const;
const LABEL: Record<string, string> = { OWNER: 'Owner', MANAGER: 'Manager', CASHIER: 'Cashier' };

function mustManage(actor: Actor) {
  if (!may(actor, PERMISSIONS.SETTINGS)) throw forbidden('Only the owner can change who works the till.', { code: 'NOT_PERMITTED' });
}

export const cleanPhone = (raw?: string | null) => {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  throw badRequest('Enter a 10-digit mobile number.');
};
export const cleanEmail = (raw?: string | null) => {
  const e = (raw ?? '').trim().toLowerCase();
  if (!e) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest('That email does not look right.');
  return e;
};
export const cleanPin = (pin: string) => {
  if (!/^\d{4}$/.test(pin ?? '')) throw badRequest('The PIN is 4 digits.');
  if (/^(\d)\1{3}$/.test(pin) || ['1234', '4321', '0123', '9876'].includes(pin)) throw badRequest('Choose a PIN that is harder to guess than ' + pin + '.');
  return pin;
};

async function roleId(clientId: string, name: string) {
  const role = await prisma.role.findUnique({ where: { clientId_name: { clientId, name } }, select: { id: true } });
  if (!role) throw conflict('This shop\'s roles are not set up. Ask ScaleEzy support.');
  return role.id;
}

const SELECT = {
  id: true, name: true, email: true, phone: true, status: true, passwordHash: true, approvalPinHash: true,
  roles: { select: { role: { select: { name: true } } } }
} as const;

const view = (u: Prisma.UserGetPayload<{ select: typeof SELECT }>, me: string | null) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone,
  role: u.roles[0]?.role.name ?? 'CASHIER', roleLabel: LABEL[u.roles[0]?.role.name ?? ''] ?? 'Staff',
  hasPin: !!u.approvalPinHash, hasPassword: !!u.passwordHash, active: u.status === 'ACTIVE', isYou: u.id === me
});

export async function list(actor: Actor) {
  mustManage(actor);
  const users = await prisma.user.findMany({ where: { clientId: actor.clientId, deletedAt: null }, orderBy: [{ status: 'asc' }, { name: 'asc' }], select: SELECT });
  return users.map(u => view(u, actor.id));
}

async function activeOwners(clientId: string, except?: string) {
  return prisma.user.count({
    where: { clientId, status: 'ACTIVE', deletedAt: null, ...(except ? { id: { not: except } } : {}), roles: { some: { role: { name: 'OWNER' } } } }
  });
}

export async function create(actor: Actor, input: { name?: string; role?: string; pin?: string; email?: string | null; phone?: string | null; password?: string | null }) {
  mustManage(actor);
  const name = (input.name ?? '').trim();
  if (name.length < 2) throw badRequest('Enter their name as the shop calls them.');
  const role = (input.role ?? 'CASHIER').toUpperCase();
  if (!(ROLES as readonly string[]).includes(role)) throw badRequest('Choose Owner, Manager or Cashier.');
  if (role === 'OWNER' && !holdsEverything(actor)) throw forbidden('Only an owner can add another owner.');
  const pin = cleanPin(input.pin ?? '');
  const email = cleanEmail(input.email);
  const phone = cleanPhone(input.phone);
  if (input.password && !email && !phone) throw badRequest('A password needs an email or phone to sign in with.');
  if (email && await prisma.user.findFirst({ where: { clientId: actor.clientId, email }, select: { id: true } })) {
    throw conflict('Someone in this shop already uses that email.');
  }
  const user = await prisma.user.create({
    data: {
      clientId: actor.clientId, name: name.slice(0, 60), email, phone,
      approvalPinHash: await bcrypt.hash(pin, 10),
      passwordHash: input.password ? await hashPassword(input.password) : null,
      roles: { create: { roleId: await roleId(actor.clientId, role) } }
    },
    select: SELECT
  });
  await record(actor, { action: 'staff.added', subject: user.name, detail: { role } });
  return view(user, actor.id);
}

export async function update(actor: Actor, id: string, input: { name?: string; role?: string; pin?: string; email?: string | null; phone?: string | null; password?: string | null; active?: boolean }) {
  mustManage(actor);
  const user = await prisma.user.findFirst({ where: { id, clientId: actor.clientId, deletedAt: null }, select: SELECT });
  if (!user) throw notFound('That person was not found.');
  const current = user.roles[0]?.role.name;
  const data: Prisma.UserUpdateInput = {};
  const changed: string[] = [];

  if (input.name !== undefined) {
    if (input.name.trim().length < 2) throw badRequest('Enter their name as the shop calls them.');
    data.name = input.name.trim().slice(0, 60); changed.push('name');
  }
  if (input.pin !== undefined) { data.approvalPinHash = await bcrypt.hash(cleanPin(input.pin), 10); changed.push('PIN'); }
  if (input.email !== undefined) {
    const email = cleanEmail(input.email);
    if (email && await prisma.user.findFirst({ where: { clientId: actor.clientId, email, id: { not: id } }, select: { id: true } })) {
      throw conflict('Someone in this shop already uses that email.');
    }
    data.email = email; changed.push('email');
  }
  if (input.phone !== undefined) { data.phone = cleanPhone(input.phone); changed.push('phone'); }
  if (input.password !== undefined) {
    data.passwordHash = input.password ? await hashPassword(input.password) : null; changed.push('password');
  }
  if (input.active !== undefined) {
    if (!input.active && id === actor.id) throw badRequest('You cannot remove yourself. Another owner can.');
    if (!input.active && current === 'OWNER' && (await activeOwners(actor.clientId, id)) === 0) throw badRequest('The shop needs at least one owner.');
    data.status = input.active ? 'ACTIVE' : 'SUSPENDED'; changed.push(input.active ? 'brought back' : 'removed');
  }
  if (input.role !== undefined && input.role.toUpperCase() !== current) {
    const role = input.role.toUpperCase();
    if (!(ROLES as readonly string[]).includes(role)) throw badRequest('Choose Owner, Manager or Cashier.');
    if ((role === 'OWNER' || current === 'OWNER') && !holdsEverything(actor)) throw forbidden('Only an owner can make or change an owner.');
    if (current === 'OWNER' && (await activeOwners(actor.clientId, id)) === 0) throw badRequest('The shop needs at least one owner.');
    await prisma.userRole.deleteMany({ where: { userId: id } });
    data.roles = { create: { roleId: await roleId(actor.clientId, role) } };
    changed.push(`role to ${LABEL[role]}`);
  }
  const done = await prisma.user.update({ where: { id }, data, select: SELECT });
  await record(actor, { action: 'staff.changed', subject: done.name, detail: { changed } });
  return view(done, actor.id);
}
