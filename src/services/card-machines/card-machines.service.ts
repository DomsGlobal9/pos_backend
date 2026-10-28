import { prisma } from '../../lib/prisma';
import { Actor, may, PERMISSIONS } from '../../types/actor';
import { badRequest, forbidden, notFound } from '../../utils/httpError';
import { seal, open } from '../../utils/credential';
import { record } from '../audit';
import { refreshMoneyStatus, duplicateReferences } from '../payments';
import { paymentUpdated } from '../events';
import { PROVIDERS, PROVIDER_NAMES, CardResult } from './providers';

/**
 * CARD MACHINES THAT CONFIRM THEMSELVES (24 Oct). The till sends the amount to the shop's card machine;
 * the customer taps or inserts there; the till is told it was approved, with the card's last 4 and the
 * approval code. Nothing to type, and no slip from another bill can be passed off as this one.
 *
 * The same rules as the self-confirming UPI QR (upi-qr.service):
 *  - the screen's "approved" is only a signal. At Complete the server asks the provider itself; only
 *    APPROVED for exactly the amount is collected.
 *  - anything else is saved as a payment to check, never refused, and the sweep settles it the moment
 *    the provider says approved. Money a customer paid is never lost, and never asked for twice.
 *  - one request pays one bill.
 *
 * Typing the slip's last 4 and approval code by hand stays, for every machine with no link (Paytm,
 * Mswipe, a bank's own machine) and for when the provider cannot be reached.
 */

const mustManage = (actor: Actor) => {
  if (!may(actor, PERMISSIONS.SETTINGS)) throw forbidden('Only the owner can set up card machines.', { code: 'NOT_PERMITTED' });
};
const mustSell = (actor: Actor) => {
  if (!may(actor, PERMISSIONS.SELL)) throw forbidden('You cannot take payments on this till.', { code: 'NOT_PERMITTED' });
};

function configOf(provider: string, raw: Record<string, unknown>, before?: Record<string, string>) {
  const p = PROVIDERS[provider];
  if (!p) throw badRequest('Choose the card machine\'s company.', { code: 'UNKNOWN_PROVIDER' });
  const cfg: Record<string, string> = {};
  for (const f of p.fields) {
    const v = String(raw[f.key] ?? '').trim();
    // A secret left blank on a change keeps the one already stored: it is never sent back to be re-typed.
    const kept = v || before?.[f.key] || '';
    if (!kept) throw badRequest(`Type the ${f.label}.`, { code: 'MISSING_FIELD', field: f.key });
    if (kept.length > 200 || /[\u0000-\u001f]/.test(kept)) throw badRequest(`The ${f.label} does not look right.`, { code: 'BAD_FIELD', field: f.key });
    cfg[f.key] = kept;
  }
  const label = p.fields.filter(f => !f.secret).map(f => `${f.label} ${cfg[f.key]}`).join(' · ').slice(0, 200);
  return { cfg, label };
}

const shown = (m: { id: string; name: string; provider: string; testMode: boolean; label: string | null; counterId: string | null; active: boolean }) => ({
  id: m.id, name: m.name, provider: m.provider, providerName: PROVIDER_NAMES[m.provider] ?? m.provider,
  testMode: m.testMode, label: m.label, counterId: m.counterId, active: m.active
});

/** The shop's machines. Anyone at the till sees names (to choose one); the ids and keys never leave. */
export async function listMachines(actor: Actor, all = false) {
  const rows = await prisma.cardMachine.findMany({ where: { clientId: actor.clientId, ...(all ? {} : { active: true }) }, orderBy: { createdAt: 'asc' } });
  return {
    machines: rows.map(shown),
    providers: Object.entries(PROVIDERS).map(([key, p]) => ({ key, name: PROVIDER_NAMES[key], fields: p.fields }))
  };
}

export async function addMachine(actor: Actor, input: { name: string; provider: string; testMode?: boolean; counterId?: string | null; config: Record<string, unknown> }) {
  mustManage(actor);
  const name = (input.name ?? '').trim().slice(0, 60);
  if (!name) throw badRequest('Give the machine a name, like "Counter 1 card machine".');
  const { cfg, label } = configOf(input.provider, input.config ?? {});
  const made = await prisma.cardMachine.create({
    data: { clientId: actor.clientId, name, provider: input.provider, testMode: input.testMode ?? true, configCipher: seal(JSON.stringify(cfg)), label, counterId: input.counterId ?? null }
  });
  await record(actor, { action: 'card_machine.added', subject: name, detail: { provider: input.provider, testMode: made.testMode } });
  return shown(made);
}

export async function changeMachine(actor: Actor, id: string, input: { name?: string; testMode?: boolean; counterId?: string | null; active?: boolean; config?: Record<string, unknown> }) {
  mustManage(actor);
  const m = await prisma.cardMachine.findFirst({ where: { id, clientId: actor.clientId } });
  if (!m) throw notFound('No such card machine.');
  const data: any = {};
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 60);
    if (!name) throw badRequest('Give the machine a name.');
    data.name = name;
  }
  if (input.testMode !== undefined) data.testMode = input.testMode;
  if (input.counterId !== undefined) data.counterId = input.counterId;
  if (input.active !== undefined) data.active = input.active;
  if (input.config) {
    const { cfg, label } = configOf(m.provider, input.config, JSON.parse(open(m.configCipher)));
    data.configCipher = seal(JSON.stringify(cfg)); data.label = label;
  }
  const saved = await prisma.cardMachine.update({ where: { id }, data });
  await record(actor, {
    action: 'card_machine.changed', subject: saved.name,
    detail: { ...(input.testMode !== undefined ? { testMode: input.testMode } : {}), ...(input.active !== undefined ? { active: input.active } : {}), ...(input.config ? { keysChanged: true } : {}) }
  });
  return shown(saved);
}

async function machineFor(clientId: string, id: string) {
  const m = await prisma.cardMachine.findFirst({ where: { id, clientId } });
  if (!m) return null;
  return { m, cfg: JSON.parse(open(m.configCipher)) as Record<string, string>, provider: PROVIDERS[m.provider] };
}

type RequestView = { requestId: string; amountPaise: number; status: string; last4: string | null; approvalCode: string | null; detail: string | null; testMode: boolean };
const view = (r: any, testMode: boolean): RequestView => ({ requestId: r.id, amountPaise: r.amountPaise, status: r.status, last4: r.last4, approvalCode: r.approvalCode, detail: r.detail, testMode });

/** Send this amount to the machine. Always answers; { ok: false, reason } means type the slip instead. */
export async function startRequest(actor: Actor, input: { machineId: string; amountPaise: number; idempotencyKey: string; billRef?: string }):
  Promise<({ ok: true } & RequestView) | { ok: false; reason: string }> {
  mustSell(actor);
  const found = await machineFor(actor.clientId, input.machineId);
  if (!found || !found.m.active) return { ok: false, reason: 'That card machine is not set up on this till. Type the slip\'s last 4 and approval code.' };
  // A second press of the same button is the same request: one amount on the machine, never two.
  const again = await prisma.cardRequest.findUnique({ where: { clientId_onceKey: { clientId: actor.clientId, onceKey: input.idempotencyKey } } });
  if (again) return { ok: true, ...view(again, found.m.testMode) };
  const billRef = (input.billRef ?? '').replace(/[^A-Za-z0-9/-]/g, '').slice(0, 20) || `T${Date.now().toString(36).toUpperCase()}`;
  const started = await found.provider.start(found.cfg, found.m.testMode, { amountPaise: input.amountPaise, billRef });
  if (!started.ok) return { ok: false, reason: `${started.detail} Type the slip's last 4 and approval code instead.` };
  const r = await prisma.cardRequest.create({
    data: { clientId: actor.clientId, machineId: found.m.id, amountPaise: input.amountPaise, providerRef: started.providerRef, onceKey: input.idempotencyKey, createdById: actor.id }
  });
  return { ok: true, ...view(r, found.m.testMode) };
}

/** Ask the provider and remember what it said. A settled answer (approved, declined, cancelled) is final. */
async function refresh(clientId: string, requestId: string, cancel = false): Promise<RequestView | null> {
  const r = await prisma.cardRequest.findFirst({ where: { id: requestId, clientId } });
  if (!r) return null;
  const found = await machineFor(clientId, r.machineId);
  if (!found) return view(r, false);
  if (r.status !== 'WAITING') return view(r, found.m.testMode);
  const said: CardResult = cancel
    ? await found.provider.cancel(found.cfg, found.m.testMode, r.providerRef, r.amountPaise)
    : await found.provider.status(found.cfg, found.m.testMode, r.providerRef, r.amountPaise);
  let data: any;
  if (said.state === 'APPROVED') {
    // Approved for a different amount is not this payment: a person looks at it.
    data = said.amountPaise === r.amountPaise
      ? { status: 'APPROVED', last4: said.last4, approvalCode: said.approvalCode, rrn: said.rrn, detail: null }
      : { detail: `The machine approved ${said.amountPaise / 100}, not ${r.amountPaise / 100}. Check with the customer — this payment is not counted.` };
  } else if (said.state === 'DECLINED' || said.state === 'CANCELLED') {
    data = { status: said.state, detail: said.detail };
  } else {
    data = { detail: said.detail ?? null };
  }
  const saved = await prisma.cardRequest.update({ where: { id: r.id }, data });
  return view(saved, found.m.testMode);
}

export async function requestStatus(actor: Actor, requestId: string) {
  const v = await refresh(actor.clientId, requestId);
  if (!v) throw notFound('No such card payment.');
  return v;
}

/** The cashier takes another way: cancel on the machine. Already approved: APPROVED, so it is taken, not lost. */
export async function cancelRequest(actor: Actor, requestId: string) {
  mustSell(actor);
  const v = await refresh(actor.clientId, requestId, true);
  if (!v) throw notFound('No such card payment.');
  return v;
}

const referenceOf = (r: { last4: string | null; approvalCode: string | null; rrn: string | null; providerRef: string }) =>
  r.last4 && r.approvalCode ? `${r.last4}/${r.approvalCode}` : (r.rrn ?? `REF ${r.providerRef}`);

/**
 * At Complete: each CARD payment carrying a cardRequestId is checked with the provider HERE. Approved for
 * exactly its amount, on a request no other payment has used: collected, its reference the slip's
 * last 4 / approval code. Otherwise kept as a payment to check, with its request, for the sweep.
 * Runs AFTER verifyQrPayments (which drops any "verified" a screen sent), and keeps what that set.
 */
export async function verifyCardPayments<T extends { method: string; amountPaise: number; cardRequestId?: string; reference?: string; unconfirmed?: boolean }>(
  clientId: string, payments: T[]
): Promise<T[]> {
  const out: T[] = [];
  for (const p of payments) {
    if (p.method !== 'CARD' || !p.cardRequestId) { out.push(p); continue; }
    const { gatewayVerified: _ignored, cardLast4: _l, approvalCode: _a, ...plain } = p as any;
    const v = await refresh(clientId, p.cardRequestId).catch(() => null);
    const r = v ? await prisma.cardRequest.findUnique({ where: { id: v.requestId } }) : null;
    // Used on a bill, or on a gift voucher sold (its payments are kept on the voucher, 24 Oct).
    const used = r
      ? await prisma.payment.count({ where: { clientId, cardRequestId: r.id, status: { in: ['COLLECTED', 'NEEDS_CHECKING'] } } }) +
        await prisma.voucherSale.count({ where: { clientId, payments: { array_contains: [{ cardRequestId: r.id }] } } })
      : 1;
    if (r && !used && r.status === 'APPROVED' && r.amountPaise === p.amountPaise) {
      out.push({ ...plain, reference: referenceOf(r), unconfirmed: false, gatewayVerified: true } as T);
    } else if (r && !used) {
      out.push({ ...plain, reference: undefined, unconfirmed: true } as T);
    } else {
      // Not this shop's request, or one already on another bill: a person checks it, with no link to it.
      const { cardRequestId: _c, ...bare } = plain;
      out.push({ ...bare, reference: undefined, unconfirmed: true } as T);
    }
  }
  return out;
}

/** THE SWEEP: a card payment saved as "to check" is settled the moment its machine says approved. */
export async function confirmCardPayments(clientId: string): Promise<number> {
  const waiting = await prisma.payment.findMany({
    where: { clientId, method: 'CARD', status: 'NEEDS_CHECKING', cardRequestId: { not: null } },
    select: { id: true, saleId: true, amountPaise: true, cardRequestId: true },
    take: 20
  });
  let settled = 0;
  for (const p of waiting) {
    const v = await refresh(clientId, p.cardRequestId!).catch(() => null);
    if (!v || v.status !== 'APPROVED' || v.amountPaise !== p.amountPaise) continue;
    const r = await prisma.cardRequest.findUniqueOrThrow({ where: { id: v.requestId } });
    const reference = referenceOf(r);
    if ((await duplicateReferences(prisma as any, clientId, [{ method: 'CARD', reference }], p.id)).length) continue;
    await prisma.$transaction(async (tx) => {
      const saved = await tx.payment.update({
        where: { id: p.id },
        data: { status: 'COLLECTED', reference, checkedAt: new Date(), checkedNote: 'Confirmed by the card machine' },
        select: { method: true, amountPaise: true, reference: true, status: true }
      });
      await refreshMoneyStatus(tx, p.saleId);
      await paymentUpdated(tx, clientId, p.saleId, p.id, [saved]);
    });
    settled++;
  }
  return settled;
}

/** One pass over every shop with a card payment waiting on its machine. */
export async function runOnce() {
  const shops = await prisma.payment.findMany({
    where: { method: 'CARD', status: 'NEEDS_CHECKING', cardRequestId: { not: null } },
    distinct: ['clientId'], select: { clientId: true }, take: 200
  });
  for (const s of shops) {
    try { await confirmCardPayments(s.clientId); }
    catch (error) { console.error(`[card-machines] sweep for ${s.clientId} failed:`, (error as Error).message); }
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Started by the server unless DISABLE_BACKGROUND_JOBS. A pass never overlaps the one before. */
export function startCardSweep(everyMs = 30_000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runOnce(); }
    catch (error) { console.error('[card-machines] pass failed:', (error as Error).message); }
    finally { running = false; }
  }, everyMs);
  timer.unref();
}
