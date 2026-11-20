import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serviceCaller, mustBeGranted, ServiceCall, ServiceScope, SERVICE_SCOPES } from '../services/module-service/pass';
import { AUD } from '../services/module-service/constants';
import { search } from '../services/items';
import { completeSale, getSale, completeSaleSchema } from '../services/sale';
import { paymentSchema } from '../services/sale/sale.schema';
import { quoteBasket, walletFor, createQr, qrStatus, closeQr } from '../services/inventory-link';
import { findByPhone, findOrCreate, detail } from '../services/customers';
import { list as listBills } from '../services/bills';
import { receiptLink, pdfFor } from '../services/receipts';
import { sendReceipt } from '../services/receipt-send';
import { collect } from '../services/orders';
import { park, list as listHeld, recall, discard } from '../services/held-bills';
import { eligibility, quote as returnQuote, createReturn, createExchange, getReturn, quoteSchema, createReturnSchema, createExchangeSchema } from '../services/returns';
import { current, open, move, close } from '../services/shifts';
import { day, closeDay } from '../services/day-close';
import { badRequest } from '../utils/httpError';

/**
 * POS AS A SERVICE FOR OTHER SCALEEZY MODULES (20 Nov): the Boutique app's retail counter.
 *
 *     Authorization: Bearer <a pass the Boutique app signed: see services/module-service/pass.ts>
 *     Idempotency-Key: <one per bill, payment, return...>   on every write; a retry gets the same answer
 *
 * The same requests the till sends, with three differences: a line names the item by its CODE (Inventory's
 * product code, or the Boutique app's own item code as `boutiqueCode`), the counter is the boutique's own
 * (never sent), and there is no manager PIN -- a manager does it under their own pass. Billing, GST, stock
 * holds, points, vouchers and the hand-over to Inventory are exactly the till's.
 *
 * Answers: { success: true, apiVersion: 1, data } or { success: false, message, details: { code } }.
 * GET /menu lists every call and the scope it needs.
 */
const router = Router();

type Call = { method: string; path: string; scope: ServiceScope | null; what: string };
const MENU: Call[] = [
  { method: 'GET', path: '/menu', scope: null, what: 'This list.' },
  { method: 'GET', path: '/me', scope: null, what: 'The shop, its counter, and what this boutique may do there.' },
  { method: 'GET', path: '/items?q=', scope: 'pos:bill:create', what: 'Find items to sell: by name, code or barcode.' },
  { method: 'GET', path: '/customers/by-phone/:phone', scope: 'pos:customer', what: 'Find a customer by number.' },
  { method: 'POST', path: '/customers', scope: 'pos:customer', what: 'Find or add a customer { phone, name? } (linked to ScaleEzy CRM).' },
  { method: 'GET', path: '/customers/:id', scope: 'pos:customer', what: 'A customer: recent bills, store credit, what they owe.' },
  { method: 'POST', path: '/quote', scope: 'pos:bill:create', what: 'Price the basket with the shop\'s offers { lines: [{ code, qty }], customerId?, couponCode? }.' },
  { method: 'GET', path: '/wallet?customerId=&billPaise=', scope: 'pos:payment', what: 'Points and store credit the customer may spend on this bill.' },
  { method: 'POST', path: '/upi-qr', scope: 'pos:payment', what: 'A UPI QR for exactly this amount { amountPaise, invoiceRef? }.' },
  { method: 'GET', path: '/upi-qr/:qrId', scope: 'pos:payment', what: 'Whether the QR has been paid.' },
  { method: 'POST', path: '/upi-qr/:qrId/close', scope: 'pos:payment', what: 'Close a QR the customer did not use.' },
  { method: 'POST', path: '/bills', scope: 'pos:bill:create', what: 'Make the bill: as the till\'s sale, lines by code. COMPLETE, or KEPT with an advance.' },
  { method: 'GET', path: '/bills', scope: 'pos:bill:read', what: 'Bills, newest first (q, from, to, status, after).' },
  { method: 'GET', path: '/bills/:id', scope: 'pos:bill:read', what: 'One bill.' },
  { method: 'GET', path: '/bills/:id/receipt.pdf', scope: 'pos:bill:read', what: 'The GST invoice as a PDF.' },
  { method: 'POST', path: '/bills/:id/receipt-link', scope: 'pos:bill:read', what: 'A link to the receipt for the customer.' },
  { method: 'POST', path: '/bills/:id/send', scope: 'pos:bill:read', what: 'Send the receipt to the bill\'s customer on WhatsApp.' },
  { method: 'POST', path: '/bills/:id/collect', scope: 'pos:payment', what: 'Take money towards what is owed on a bill { payments }.' },
  { method: 'GET', path: '/held-bills', scope: 'pos:bill:create', what: 'Bills parked at this counter.' },
  { method: 'POST', path: '/held-bills', scope: 'pos:bill:create', what: 'Park a bill { label?, payload }.' },
  { method: 'POST', path: '/held-bills/:id/recall', scope: 'pos:bill:create', what: 'Take a parked bill back.' },
  { method: 'DELETE', path: '/held-bills/:id', scope: 'pos:bill:create', what: 'Throw a parked bill away.' },
  { method: 'GET', path: '/bills/:id/returnable', scope: 'pos:return', what: 'What on this bill can come back, and until when.' },
  { method: 'POST', path: '/bills/:id/return-quote', scope: 'pos:return', what: 'What a return would give back { lines: [{ saleLineId, qty }] }.' },
  { method: 'POST', path: '/bills/:id/returns', scope: 'pos:return', what: 'Take goods back { lines, reason, refund: { method } }.' },
  { method: 'POST', path: '/bills/:id/exchanges', scope: 'pos:return', what: 'Goods back, other goods out { lines, reason, newSale: { lines by code, payments } }.' },
  { method: 'GET', path: '/returns/:id', scope: 'pos:return', what: 'One return (credit note).' },
  { method: 'GET', path: '/drawer', scope: 'pos:day', what: 'The counter\'s drawer: open or not, and what should be in it.' },
  { method: 'POST', path: '/drawer/open', scope: 'pos:day', what: 'Open the drawer { openingCashPaise }.' },
  { method: 'POST', path: '/drawer/cash', scope: 'pos:day', what: 'Cash in or out { direction, amountPaise, reason }.' },
  { method: 'POST', path: '/drawer/close', scope: 'pos:day', what: 'Count and close the drawer { countedCashPaise, note? }.' },
  { method: 'GET', path: '/day/:date', scope: 'pos:day', what: 'The shop\'s day: sales, payments, returns (YYYY-MM-DD).' },
  { method: 'POST', path: '/day/:date/close', scope: 'pos:day', what: 'Close the shop\'s day (a manager). { again: true } takes in bills made after an earlier close.' }
];

router.get('/menu', (_req, res) => {
  res.json({ success: true, apiVersion: 1, data: { audience: AUD, scopes: SERVICE_SCOPES, calls: MENU } });
});

// Who is calling: the pass, the shop, the person. Everything below runs as that person.
router.use(async (req: Request, _res: Response, next: NextFunction) => {
  try { (req as any).service = await serviceCaller(req.headers.authorization); (req as any).actor = (req as any).service.actor; next(); }
  catch (e) { next(e); }
});

// Per boutique, not per address: its staff share one office connection.
router.use(rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `link:${(req as any).service.link.id}`,
  message: { success: false, message: 'Too many calls from this boutique: at most 300 a minute. Wait and send again.', details: { code: 'RATE_LIMITED' } }
}));

const svc = (req: Request) => (req as any).service as ServiceCall;
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, apiVersion: 1, data });

/** One handler: the scope first (refused before anything is read), then the work. */
type Req = Request<Record<string, string>>;
const handle = (scope: ServiceScope | null, run: (req: Req, res: Response, call: ServiceCall) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const call = svc(req);
      if (scope) mustBeGranted(call, scope);
      const out = await run(req as Req, res, call);
      if (out !== undefined && !res.headersSent) ok(res, out);
    } catch (e) { next(e); }
  };

/**
 * The one-per-write key: the Idempotency-Key header, or onceKey in the body as the till sends it. Kept apart
 * from the till's own keys ("bq:" in front), so a key the Boutique app makes can never replay a till's bill.
 */
function onceKey(req: Request): string {
  const k = String(req.headers['idempotency-key'] ?? req.body?.onceKey ?? '').trim();
  if (k.length < 8 || k.length > 96) throw badRequest('Send an Idempotency-Key (8 to 96 characters) with every write.', { code: 'NO_IDEMPOTENCY_KEY' });
  return `bq:${k}`;
}

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) { const i = r.error.issues[0]; throw badRequest(i.message, { field: i.path.join('.') }); }
  return r.data;
};

/**
 * Lines name items by code: Inventory's product code, the Boutique app's own item code (`boutiqueCode`, which
 * Inventory lists as "BV-" + that code), or a scanned `barcode`. Each becomes the shop's item, or the call is
 * refused naming it.
 */
async function byCode(clientId: string, lines: unknown): Promise<any[]> {
  if (!Array.isArray(lines)) return lines as any;
  const codeOf = (l: any) => typeof l?.code === 'string' && l.code.trim() ? l.code.trim()
    : typeof l?.boutiqueCode === 'string' && l.boutiqueCode.trim() ? `BV-${l.boutiqueCode.trim()}`.slice(0, 63) : null;
  const barOf = (l: any) => typeof l?.barcode === 'string' && l.barcode.trim() ? l.barcode.trim() : null;
  const codes = [...new Set(lines.map(codeOf).filter((c): c is string => !!c))];
  const bars = [...new Set(lines.map(barOf).filter((c): c is string => !!c))];
  const items = codes.length || bars.length ? await prisma.item.findMany({
    where: { clientId, OR: [...(codes.length ? [{ code: { in: codes } }] : []), ...(bars.length ? [{ barcode: { in: bars } }] : [])] },
    select: { id: true, code: true, barcode: true, active: true, name: true }
  }) : [];
  const found = new Map(items.map(i => [i.code, i]));
  const byBar = new Map(items.filter(i => i.barcode).map(i => [i.barcode!, i]));
  return lines.map((l: any) => {
    const named = codeOf(l);
    const code = named ?? barOf(l);
    if (!code) throw badRequest('Each line needs the item\'s code or barcode.', { code: 'NO_CODE' });
    const item = named ? found.get(code) : byBar.get(code);
    if (!item) throw badRequest(`No item with code ${code} is sold at this shop.`, { code: 'ITEM_UNKNOWN', itemCode: code });
    if (!item.active) throw badRequest(`${item.name} (${code}) is no longer sold. Take it off the bill.`, { code: 'ITEM_NOT_SOLD', itemCode: code });
    const { code: _c, boutiqueCode: _b, barcode: _bc, ...rest } = l;
    return { ...rest, itemId: item.id };
  });
}

/** What the till would send for a sale, made from the Boutique app's request: its counter, no PIN, no offline. */
async function asSale(call: ServiceCall, body: any, key: string) {
  const { approval: _a, madeOfflineAt: _m, counterId: _c, ...rest } = body ?? {};
  return parse(completeSaleSchema, { ...rest, onceKey: key, counterId: call.link.counterId, lines: await byCode(call.link.clientId, rest.lines) });
}

/* ---- Who am I ---------------------------------------------------------------------------------- */
router.get('/me', handle(null, async (_req, _res, call) => {
  const shop = await prisma.shopSettings.findFirst({ where: { clientId: call.link.clientId }, select: { shopName: true } });
  const counter = await prisma.counter.findUnique({ where: { id: call.link.counterId }, select: { id: true, name: true } });
  return { shop: shop?.shopName ?? null, counter, scopes: call.link.scopes, person: { name: call.actor.name, role: call.actor.roles[0] } };
}));

/* ---- Items and customers ----------------------------------------------------------------------- */
router.get('/items', handle('pos:bill:create', req => search((req as any).actor, req.query.q)));
router.get('/customers/by-phone/:phone', handle('pos:customer', req => findByPhone((req as any).actor, req.params.phone)));
router.post('/customers', handle('pos:customer', async (req, res) => {
  const b = parse(z.object({ phone: z.string().min(1, 'Enter a phone number'), name: z.string().trim().max(120).optional(), gstin: z.string().trim().max(20).optional(), marketingConsent: z.boolean().optional() }), req.body);
  const r = await findOrCreate((req as any).actor, b);
  ok(res, r, r.created ? 201 : 200);
}));
router.get('/customers/:id', handle('pos:customer', req => detail((req as any).actor, req.params.id)));

/* ---- Pricing and payments ---------------------------------------------------------------------- */
router.post('/quote', handle('pos:bill:create', async (req, _res, call) => {
  const b = parse(z.object({ lines: z.array(z.object({ itemId: z.string().min(1), qty: z.number().int().positive() })).min(1).max(100), customerId: z.string().min(1).optional(), couponCode: z.string().trim().min(1).max(40).optional() }),
    { ...req.body, lines: await byCode(call.link.clientId, req.body?.lines) });
  return quoteBasket(call.actor, b);
}));
router.get('/wallet', handle('pos:payment', req => {
  const q = parse(z.object({ customerId: z.string().min(1), billPaise: z.coerce.number().int().nonnegative().max(2_000_000_000) }), req.query);
  return walletFor((req as any).actor, q.customerId, q.billPaise);
}));
router.post('/upi-qr', handle('pos:payment', req => {
  const b = parse(z.object({ amountPaise: z.number().int().positive().max(2_000_000_000), invoiceRef: z.string().max(60).optional() }), req.body);
  return createQr((req as any).actor, { ...b, idempotencyKey: onceKey(req) });
}));
router.get('/upi-qr/:qrId', handle('pos:payment', (req, _res, call) => qrStatus(call.link.clientId, req.params.qrId)));
router.post('/upi-qr/:qrId/close', handle('pos:payment', (req, _res, call) => closeQr(call.link.clientId, req.params.qrId)));

/* ---- Bills ------------------------------------------------------------------------------------- */
router.post('/bills', handle('pos:bill:create', async (req, res, call) => {
  const r = await completeSale(call.actor, await asSale(call, req.body, onceKey(req)));
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  ok(res, r, r.replayed ? 200 : 201);
}));
router.get('/bills', handle('pos:bill:read', req => {
  const f = parse(z.object({ q: z.string().trim().max(60).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: z.enum(['COMPLETED', 'BALANCE_DUE', 'RETURNED', 'PENDING_SYNC']).optional(), after: z.string().min(1).optional() }), req.query);
  return listBills((req as any).actor, f);
}));
router.get('/bills/:id', handle('pos:bill:read', req => getSale((req as any).actor, req.params.id)));
router.get('/bills/:id/receipt.pdf', handle('pos:bill:read', async (req, res) => {
  const { pdf, invoiceNo } = await pdfFor((req as any).actor, req.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoiceNo.replace(/[^\w-]+/g, '-')}.pdf"`);
  res.send(pdf);
}));
router.post('/bills/:id/receipt-link', handle('pos:bill:read', req => receiptLink((req as any).actor, req.params.id)));
router.post('/bills/:id/send', handle('pos:bill:read', async (req, res) => {
  const r = await sendReceipt((req as any).actor, req.params.id, { onceKey: onceKey(req), channel: 'WHATSAPP' });
  ok(res, r, r.replayed ? 200 : 201);
}));
router.post('/bills/:id/collect', handle('pos:payment', async (req, res, call) => {
  const b = parse(z.object({ payments: z.array(paymentSchema).min(1, 'Nothing has been paid').max(6) }), req.body);
  const r = await collect(call.actor, req.params.id, { onceKey: onceKey(req), payments: b.payments, counterId: call.link.counterId });
  ok(res, r, r.replayed ? 200 : 201);
}));

/* ---- Parked bills: this counter's only ------------------------------------------------------------ */
router.get('/held-bills', handle('pos:bill:create', async (req, _res, call) => {
  const all = await listHeld(call.actor) as any[];
  return Array.isArray(all) ? all.filter(h => !h.counterId || h.counterId === call.link.counterId) : all;
}));
router.post('/held-bills', handle('pos:bill:create', async (req, res, call) => {
  const { counterId: _c, ...body } = req.body ?? {};
  const r = await park(call.actor, { ...body, counterId: call.link.counterId } as any);
  ok(res, r, 201);
}));
router.post('/held-bills/:id/recall', handle('pos:bill:create', req => recall((req as any).actor, req.params.id)));
router.delete('/held-bills/:id', handle('pos:bill:create', req => discard((req as any).actor, req.params.id)));

/* ---- Returns and exchanges --------------------------------------------------------------------- */
router.get('/bills/:id/returnable', handle('pos:return', req => eligibility((req as any).actor, req.params.id)));
router.post('/bills/:id/return-quote', handle('pos:return', req => returnQuote((req as any).actor, req.params.id, parse(quoteSchema, req.body).lines)));
router.post('/bills/:id/returns', handle('pos:return', async (req, res, call) => {
  const { approval: _a, counterId: _c, ...body } = req.body ?? {};
  const r = await createReturn(call.actor, req.params.id, parse(createReturnSchema, { ...body, onceKey: onceKey(req), counterId: call.link.counterId }));
  ok(res, r, r.replayed ? 200 : 201);
}));
router.post('/bills/:id/exchanges', handle('pos:return', async (req, res, call) => {
  const { approval: _a, ...body } = req.body ?? {};
  const ns = body.newSale ?? {};
  const newSale = { ...ns, counterId: call.link.counterId, lines: await byCode(call.link.clientId, ns.lines) };
  const r = await createExchange(call.actor, req.params.id, parse(createExchangeSchema, { ...body, onceKey: onceKey(req), newSale }));
  ok(res, r, r.replayed ? 200 : 201);
}));
router.get('/returns/:id', handle('pos:return', req => getReturn((req as any).actor, req.params.id)));

/* ---- The drawer and the day -------------------------------------------------------------------- */
router.get('/drawer', handle('pos:day', (_req, _res, call) => current(call.actor, call.link.counterId)));
router.post('/drawer/open', handle('pos:day', async (req, res, call) => {
  const b = parse(z.object({ openingCashPaise: z.number().int().nonnegative('The float cannot be negative').max(1_000_000_000) }), req.body);
  ok(res, await open(call.actor, { counterId: call.link.counterId, openingCashPaise: b.openingCashPaise }), 201);
}));
router.post('/drawer/cash', handle('pos:day', async (req, res, call) => {
  const b = parse(z.object({ direction: z.enum(['IN', 'OUT']), amountPaise: z.number().int().positive('Enter an amount').max(1_000_000_000), reason: z.string().trim().max(200) }), req.body);
  const r = await move(call.actor, { ...b, counterId: call.link.counterId, onceKey: onceKey(req) });
  ok(res, r, r.replayed ? 200 : 201);
}));
router.post('/drawer/close', handle('pos:day', async (req, _res, call) => {
  const b = parse(z.object({ countedCashPaise: z.number().int().nonnegative('Enter what you counted').max(1_000_000_000), note: z.string().max(280).optional() }), req.body);
  const id = (await current(call.actor, call.link.counterId)).open?.id;
  if (!id) throw badRequest('The drawer is not open.', { code: 'DRAWER_NOT_OPEN' });
  return close(call.actor, id, b);
}));
router.get('/day/:date', handle('pos:day', req => day((req as any).actor, req.params.date)));
router.post('/day/:date/close', handle('pos:day', req => {
  const b = parse(z.object({ acceptOpenShifts: z.boolean().optional(), note: z.string().max(280).optional(), again: z.boolean().optional() }), req.body ?? {});
  return closeDay((req as any).actor, req.params.date, b);
}));

export default router;
