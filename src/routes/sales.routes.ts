import { Router } from 'express';
import { z } from 'zod';
import { search, variantsOf } from '../services/items';
import { completeSale, getSale, completeSaleSchema } from '../services/sale';
import { quoteBasket, walletFor, createQr, qrStatus, closeQr } from '../services/inventory-link';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

/**
 * The till's own endpoints.
 *
 * Routes are the ONLY place that knows an HTTP request exists. Each one pulls the Actor off the
 * request, validates the body, and calls a service function with plain arguments -- which is what
 * makes the public API for a client's own software (step 9) a key check in front of these same
 * service functions rather than a second implementation of all of them.
 */
const router = Router();

// Until sign-in is built, every request carries a development Actor. This middleware refuses to
// do anything outside development -- see the file for why that check is there and not elsewhere.
router.use(devActor);

/** GET /api/v1/sales/items?q=  -- find something to sell. */
router.get('/items', async (req, res, next) => {
  try {
    res.json({ success: true, data: await search((req as any).actor, req.query.q) });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/sales/variants/:group -- POS-SELL-006, the data for WF-PRODUCT-01. */
router.get('/variants/:group', async (req, res, next) => {
  try {
    const group = z.string().min(1).max(120).parse(req.params.group);
    res.json({ success: true, data: await variantsOf((req as any).actor, group) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/sales/quote -- what this basket comes to with the shop's offers on it. Contract §9.
 *
 * Always 200: a quote that could not be had is `{ ok: false, reason }`, which the till shows as one
 * plain line and sells on. The till sends ids and quantities; the answer is held here by its id.
 */
router.post('/quote', async (req, res, next) => {
  try {
    const body = z.object({
      lines: z.array(z.object({ itemId: z.string().min(1), qty: z.number().int().positive() })).min(1).max(100),
      customerId: z.string().min(1).optional(),
      couponCode: z.string().trim().min(1).max(40).optional()
    }).safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    res.json({ success: true, data: await quoteBasket((req as any).actor, body.data) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/sales/wallet?customerId=&billPaise= -- what this customer may spend in points and store
 * credit on this bill, from Inventory (contract §10). Always 200: `{ ok: false, reason }` is one line
 * for the cashier, and the payment screen simply does not offer points.
 */
router.get('/wallet', async (req, res, next) => {
  try {
    const q = z.object({ customerId: z.string().min(1), billPaise: z.coerce.number().int().nonnegative().max(2_000_000_000) }).safeParse(req.query);
    if (!q.success) throw badRequest('Say whose wallet, and for how much.');
    res.json({ success: true, data: await walletFor((req as any).actor, q.data.customerId, q.data.billPaise) });
  } catch (error) {
    next(error);
  }
});

/*
 * SELF-CONFIRMING UPI (PLAN-payments Step 2). A QR for exactly this amount from the shop's own Razorpay,
 * through Inventory; its status while the customer pays; closing it when the cashier takes another way.
 * Always 200 with { ok: false, reason } for "not here" -- the till then shows the shop's own QR.
 */
router.post('/upi-qr', async (req, res, next) => {
  try {
    const b = z.object({ amountPaise: z.number().int().positive().max(2_000_000_000), idempotencyKey: z.string().min(8).max(120), invoiceRef: z.string().max(60).optional() }).safeParse(req.body);
    if (!b.success) throw badRequest('Say how much the QR is for.');
    res.json({ success: true, data: await createQr((req as any).actor, b.data) });
  } catch (error) {
    next(error);
  }
});

router.get('/upi-qr/:qrId', async (req, res, next) => {
  try {
    res.json({ success: true, data: await qrStatus((req as any).actor.clientId, req.params.qrId) });
  } catch (error) {
    next(error);
  }
});

router.post('/upi-qr/:qrId/close', async (req, res, next) => {
  try {
    res.json({ success: true, data: await closeQr((req as any).actor.clientId, req.params.qrId) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/sales  -- complete a sale. Idempotent on onceKey. */
router.post('/', async (req, res, next) => {
  try {
    const parsed = completeSaleSchema.safeParse(req.body);
    if (!parsed.success) {
      // One sentence, the first problem, named. A cashier cannot act on a list of zod issues.
      const issue = parsed.error.issues[0];
      throw badRequest(issue.message, { field: issue.path.join('.') });
    }
    const result = await completeSale((req as any).actor, parsed.data);
    // 200 rather than 201 on a replay: nothing was created the second time, and a till that
    // branches on the status code should see the difference.
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/sales/:id  -- one bill, as a receipt reads it. */
router.get('/:id', async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    res.json({ success: true, data: await getSale((req as any).actor, id) });
  } catch (error) {
    next(error);
  }
});

export default router;
