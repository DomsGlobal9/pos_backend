/**
 * verify-approvals -- a manager saying yes, in place, and what must still say no. Phase 4.
 *
 *     node src/scripts/local-db.mjs start       (in another terminal)
 *     npm run verify:approvals
 *
 * The people involved come from seed-dev:
 *
 *     dev-cashier    CASHIER    no PIN     has to ask
 *     dev-manager    MANAGER    2468       can approve
 *     dev-manager-2  MANAGER    9753       a second manager
 *     dev-owner      OWNER      1357       can do anything
 *     dev-senior     CASHIER    4455       HAS a PIN, has no right to approve
 *
 * The last one is the case that matters most and is easiest to get wrong: a PIN that is real, typed
 * correctly, by a real person -- and the answer must still be no.
 */

import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { DEV_CLIENT_ID } from '../middleware/dev-actor.middleware';
import { completeSale } from '../services/sale';
import { __resetLockouts, grant } from '../services/approvals';
import { seed } from './seed-dev';

let passed = 0;
let failed = 0;

const ok = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

async function refused(name: string, run: () => Promise<unknown>, expect: RegExp, code?: string) {
  try {
    await run();
    failed++;
    console.error(`  FAIL  ${name}\n          it was allowed, and should not have been`);
  } catch (error: any) {
    const messageOk = expect.test(error.message ?? '');
    const codeOk = !code || error.details?.code === code;
    ok(name, messageOk && codeOk,
      `message was: ${error.message}${code ? ` / code ${error.details?.code}` : ''}`);
  }
}

/** Load a seeded person the way devActor does -- real roles, real permissions. */
async function actorFor(userId: string): Promise<Actor> {
  const user = await prisma.user.findFirstOrThrow({
    where: { id: userId, clientId: DEV_CLIENT_ID },
    select: {
      id: true, name: true,
      roles: { select: { role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } } } }
    }
  });
  return {
    kind: 'USER', clientId: DEV_CLIENT_ID, id: user.id, name: user.name,
    roles: user.roles.map(r => r.role.name),
    permissions: [...new Set(user.roles.flatMap(r => r.role.permissions.map(p => p.permission.key)))]
  };
}

async function main() {
  console.log('\nverify-approvals\n');
  const { counterId } = await seed();
  __resetLockouts();

  const cashier = await actorFor('dev-cashier');
  const owner = await actorFor('dev-owner');
  const senior = await actorFor('dev-senior');

  // The shop's cashier limit is 10% (seed-dev). A cotton saree is 1,299.00.
  const cotton = await prisma.item.findFirstOrThrow({
    where: { clientId: DEV_CLIENT_ID, code: 'COT-010' }, select: { id: true, pricePaise: true }
  });
  const run = randomUUID().slice(0, 8);
  const key = (n: string) => `apr-${run}-${n}`;

  /** A one-saree sale with a bill discount, paid in full in cash. */
  const sale = (actor: Actor, name: string, extra: any = {}) => {
    const discount = extra.billDiscountPaise ?? 0;
    const price = extra.overridePricePaise ?? cotton.pricePaise;
    const gross = price - discount;
    const whole = Math.floor(gross / 100) * 100;
    const total = gross - whole >= 50 ? whole + 100 : whole;
    return completeSale(actor, {
      onceKey: key(name),
      counterId,
      lines: [{ itemId: cotton.id, qty: 1,
        ...(extra.overridePricePaise ? { overridePricePaise: extra.overridePricePaise } : {}) }],
      payments: [{ method: 'CASH', amountPaise: total }],
      ...(discount ? { billDiscountPaise: discount } : {}),
      ...(extra.approval ? { approval: extra.approval } : {})
    });
  };

  // ==========================================================================================
  console.log('a discount inside the limit needs nobody');
  // ==========================================================================================
  const small = await sale(cashier, 'small', { billDiscountPaise: 10000 });   // ~7.7%
  ok('a cashier gives 100 off a 1,299 saree on their own', small.sale.discountPaise === 10000);

  const atLimit = await sale(cashier, 'at-limit', { billDiscountPaise: 12990 }); // exactly 10%
  ok('exactly at the limit is still within it', atLimit.sale.discountPaise === 12990);

  const noApprovalRows = await prisma.approval.count({ where: { saleId: small.sale.id } });
  eq('and no approval is recorded for it', noApprovalRows, 0);

  // ==========================================================================================
  console.log('\nover the limit, a cashier has to ask');
  // ==========================================================================================
  await refused('20% with nobody approving is refused',
    () => sale(cashier, 'over-noapproval', { billDiscountPaise: 26000 }),
    /manager needs to approve a discount over 10%/, 'APPROVAL_REQUIRED');

  const refusal = await sale(cashier, 'over-detail', { billDiscountPaise: 26000 })
    .catch((e: any) => e.details);
  eq('and the refusal tells the screen what limit applies', refusal?.limitPercent, 10);
  eq('and what the discount came to', refusal?.discountPaise, 26000);

  // ==========================================================================================
  console.log('\na manager walks over and types their PIN');
  // ==========================================================================================
  const approved = await sale(cashier, 'over-approved', {
    billDiscountPaise: 26000,
    approval: { pin: '2468', reason: 'Regular customer, damaged border' }
  });
  ok('the sale goes through', approved.sale.discountPaise === 26000);

  const approval = await prisma.approval.findFirst({
    where: { saleId: approved.sale.id },
    select: { kind: true, reason: true, requestedById: true, approvedById: true, detail: true }
  });
  eq('an approval is recorded against the sale', approval?.kind, 'DISCOUNT_OVER_LIMIT');
  eq('naming who asked', approval?.requestedById, 'dev-cashier');
  eq('and who agreed', approval?.approvedById, 'dev-manager');
  eq('and the reason, as typed', approval?.reason, 'Regular customer, damaged border');
  eq('and exactly what was allowed', (approval?.detail as any)?.discountPaise, 26000);

  // The cashier never logged out -- the same actor made the sale.
  ok('and the cashier never signed out: the sale is theirs',
    (await prisma.sale.findUnique({ where: { id: approved.sale.id }, select: { cashierId: true } }))
      ?.cashierId === 'dev-cashier');

  // ==========================================================================================
  console.log('\nthe PIN has to be right, and has to belong to someone who may say yes');
  // ==========================================================================================
  await refused('a wrong PIN',
    () => sale(cashier, 'wrong-pin', { billDiscountPaise: 26000, approval: { pin: '0000', reason: 'Trying it on' } }),
    /PIN was not recognised/, 'PIN_NOT_RECOGNISED');

  __resetLockouts();

  /*
   * The case that matters most. 4455 is a real PIN, typed correctly, belonging to a real person
   * -- a senior cashier who has a PIN for other reasons but no right to approve a discount. The
   * answer must still be no, and it must say why.
   */
  await refused('a REAL PIN belonging to someone who may not approve',
    () => sale(cashier, 'senior-pin', { billDiscountPaise: 26000, approval: { pin: '4455', reason: 'Asked Ravi' } }),
    /not allowed to approve a discount above the limit/, 'NOT_PERMITTED');

  await refused('no reason',
    () => sale(cashier, 'no-reason', { billDiscountPaise: 26000, approval: { pin: '2468', reason: '' } }),
    /Say why/);

  await refused('"na" is not a reason',
    () => sale(cashier, 'na', { billDiscountPaise: 26000, approval: { pin: '2468', reason: 'na' } }),
    /Say why/, 'REASON_REQUIRED');

  // ==========================================================================================
  console.log('\nsomeone who may do it themselves does not have to ask');
  // ==========================================================================================
  const ownerSale = await sale(owner, 'owner-discount', { billDiscountPaise: 26000 });
  ok('the owner gives 20% without anyone approving', ownerSale.sale.discountPaise === 26000);
  eq('no approval row, because nobody else agreed to anything',
    await prisma.approval.count({ where: { saleId: ownerSale.sale.id } }), 0);

  const audited = await prisma.auditLog.findFirst({
    where: { clientId: DEV_CLIENT_ID, action: 'sale.discount_over_limit', actorId: 'dev-owner' },
    orderBy: { createdAt: 'desc' },
    select: { actorName: true, detail: true }
  });
  ok('but it IS in the audit trail', Boolean(audited));
  eq('with the owner named', audited?.actorName, 'Lakshmi (owner)');
  eq('and marked as their own authority', (audited?.detail as any)?.byOwnAuthority, true);

  // ==========================================================================================
  console.log('\nselling at a different price');
  // ==========================================================================================
  await refused('a cashier changing a price with nobody approving',
    () => sale(cashier, 'override-noapproval', { overridePricePaise: 100000 }),
    /manager needs to approve a price change/, 'APPROVAL_REQUIRED');

  const override = await sale(cashier, 'override-approved', {
    overridePricePaise: 100000,
    approval: { pin: '2468', reason: 'Last piece, faded in the window' }
  });
  const line = await prisma.saleLine.findFirst({
    where: { saleId: override.sale.id },
    select: { unitPricePaise: true, listPricePaise: true, priceOverrideReason: true }
  });
  eq('it is charged at the new price', line?.unitPricePaise, 100000);
  eq('with the tag price kept beside it, so the override is visible forever', line?.listPricePaise, cotton.pricePaise);
  eq('and the reason on the line', line?.priceOverrideReason, 'Last piece, faded in the window');

  const samePrice = await sale(cashier, 'override-same', { overridePricePaise: cotton.pricePaise });
  const sameLine = await prisma.saleLine.findFirst({
    where: { saleId: samePrice.sale.id }, select: { listPricePaise: true }
  });
  eq('"overriding" to the tag price is not an override, and needs nobody', sameLine?.listPricePaise, null);

  const ordinary = await prisma.saleLine.findFirst({
    where: { saleId: small.sale.id }, select: { listPricePaise: true, priceOverrideReason: true }
  });
  eq('an ordinary line carries no tag-price column at all', ordinary?.listPricePaise, null);

  // ==========================================================================================
  console.log('\nboth at once');
  // ==========================================================================================
  const both = await sale(cashier, 'both', {
    overridePricePaise: 100000,
    billDiscountPaise: 30000,
    approval: { pin: '2468', reason: 'Bulk order for a wedding' }
  });
  const kinds = (await prisma.approval.findMany({
    where: { saleId: both.sale.id }, select: { kind: true }
  })).map(a => a.kind).sort();
  eq('a price change AND a big discount make two approvals, one for each',
    kinds, ['DISCOUNT_OVER_LIMIT', 'PRICE_OVERRIDE']);

  // ==========================================================================================
  console.log('\nan approval is only as real as the sale it belonged to');
  // ==========================================================================================
  const before = await prisma.approval.count({ where: { clientId: DEV_CLIENT_ID } });
  await refused('a sale that fails after the manager said yes',
    () => completeSale(cashier, {
      onceKey: key('rollback'), counterId,
      lines: [{ itemId: cotton.id, qty: 1 }],
      billDiscountPaise: 26000,
      approval: { pin: '2468', reason: 'Will not complete' },
      payments: [{ method: 'CASH', amountPaise: 1 }]   // wrong on purpose
    }),
    /still to pay/);
  eq('leaves no approval behind -- a yes for something that never happened is a lie',
    await prisma.approval.count({ where: { clientId: DEV_CLIENT_ID } }), before);

  // ==========================================================================================
  console.log('\nthe audit trail only records things that happened');
  // ==========================================================================================
  /*
   * The owner gives 20% on their own authority, which is audited -- and then the payment is wrong
   * and the sale rolls back. If the audit row survives, the trail claims a discount that was never
   * given, on a sale that does not exist. An audit trail that records things which did not happen
   * is worse than none, because it is believed.
   */
  const auditBefore = await prisma.auditLog.count({
    where: { clientId: DEV_CLIENT_ID, action: 'sale.discount_over_limit' }
  });
  await refused('the owner\'s discounted sale fails on its payment',
    () => completeSale(owner, {
      onceKey: key('audit-rollback'), counterId,
      lines: [{ itemId: cotton.id, qty: 1 }],
      billDiscountPaise: 26000,
      payments: [{ method: 'CASH', amountPaise: 1 }]
    }),
    /still to pay/);
  eq('and leaves NO audit entry behind for a discount that was never given',
    await prisma.auditLog.count({ where: { clientId: DEV_CLIENT_ID, action: 'sale.discount_over_limit' } }),
    auditBefore);

  /*
   * And the other way round: a MANAGER-approved override must appear in the audit trail too. The
   * approval row records it, but the owner reads the audit screen -- and an audit that shows the
   * owner's own discounts but hides the ones their managers approved is backwards.
   */
  const grantedAudit = await prisma.auditLog.findFirst({
    where: { clientId: DEV_CLIENT_ID, action: 'approval.granted', subject: override.sale.invoiceNo },
    select: { actorName: true, detail: true }
  });
  ok('a manager-approved price change appears in the audit trail', Boolean(grantedAudit));
  eq('naming the manager who approved it', (grantedAudit?.detail as any)?.approvedBy, 'Meena (manager)');
  eq('and the cashier who asked', grantedAudit?.actorName, 'Dev cashier');

  // ==========================================================================================
  console.log('\nguessing PINs');
  // ==========================================================================================
  __resetLockouts();
  for (let i = 0; i < 5; i++) {
    await sale(cashier, `guess-${i}`, { billDiscountPaise: 26000, approval: { pin: `11${i}1`, reason: 'Guessing' } })
      .catch(() => null);
  }
  await refused('five wrong tries lock the PIN out',
    () => sale(cashier, 'after-guesses', { billDiscountPaise: 26000, approval: { pin: '2468', reason: 'Now the right one' } }),
    /Too many wrong PINs/, 'PIN_LOCKED_OUT');
  // ...even with the RIGHT PIN, which is the point of a lockout.
  __resetLockouts();

  const afterReset = await sale(cashier, 'after-reset', {
    billDiscountPaise: 26000, approval: { pin: '2468', reason: 'Lockout cleared' }
  });
  ok('and once it clears, the right PIN works again', afterReset.sale.discountPaise === 26000);

  // ==========================================================================================
  console.log('\ntwo managers with the same PIN');
  // ==========================================================================================
  const original = await prisma.user.findUniqueOrThrow({
    where: { id: 'dev-manager-2' }, select: { approvalPinHash: true }
  });
  await prisma.user.update({
    where: { id: 'dev-manager-2' }, data: { approvalPinHash: await bcrypt.hash('2468', 10) }
  });
  /*
   * Recording the approval against whichever row came back first would put a manager's name
   * against something they never did. Refusing is the only honest answer.
   */
  await refused('is refused, rather than guessing which of them it was',
    () => sale(cashier, 'ambiguous', { billDiscountPaise: 26000, approval: { pin: '2468', reason: 'Who was it' } }),
    /Two people have that PIN/, 'PIN_AMBIGUOUS');
  await prisma.user.update({
    where: { id: 'dev-manager-2' }, data: { approvalPinHash: original.approvalPinHash }
  });

  // ==========================================================================================
  console.log('\nyou cannot approve yourself');
  // ==========================================================================================
  /*
   * Normally unreachable: a manager has the permission, so they never ask. It fires when the
   * session is stale -- permissions loaded before a role change -- and the person then types
   * their own PIN. Two names on an approval must be two people, or the field is decoration.
   */
  const staleManager: Actor = { ...(await actorFor('dev-manager')), permissions: [], roles: [] };
  await refused('a manager typing their own PIN for their own request',
    () => sale(staleManager, 'self', { billDiscountPaise: 26000, approval: { pin: '2468', reason: 'Approving myself' } }),
    /no approval needed/, 'SELF_APPROVAL');

  // ==========================================================================================
  console.log('\nanother shop');
  // ==========================================================================================
  __resetLockouts();
  /*
   * Called on grant() directly. The first version of this test went through completeSale, which
   * fails on the ITEM lookup (items are per-shop) before the PIN is ever checked -- so it passed
   * without proving anything about PINs at all. Found by reading the test back, not by it failing.
   */
  const elsewhere: Actor = { ...cashier, clientId: 'some-other-shop' };
  await refused('cannot use this shop\'s manager PIN -- managers belong to their own shop',
    () => grant(elsewhere, { kind: 'DISCOUNT_OVER_LIMIT', pin: '2468', reason: 'Wrong shop' }),
    /PIN was not recognised/, 'PIN_NOT_RECOGNISED');

  // ==========================================================================================
  console.log('\na senior cashier with a PIN is still a cashier');
  // ==========================================================================================
  await refused('who cannot give themselves 20% either',
    () => sale(senior, 'senior-self', { billDiscountPaise: 26000 }),
    /manager needs to approve/, 'APPROVAL_REQUIRED');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nthe suite itself broke:\n', error);
  await prisma.$disconnect();
  process.exit(1);
});
