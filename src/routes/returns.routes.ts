import { Router } from 'express';
import {
  eligibility, quote, createReturn, createExchange, getReturn,
  quoteSchema, createReturnSchema, createExchangeSchema
} from '../services/returns';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

/**
 * Returns and exchanges. WF-RETURN-01, WF-EXCHANGE-01.
 *
 * Everything hangs off the ORIGINAL BILL (POS-RET-001): a return is always against something the
 * shop sold, never a free-standing refund. A refund with no bill behind it is the oldest way money
 * leaves a till.
 */
const router = Router();
router.use(devActor);

/** GET /api/v1/returns/bill/:saleId -- what can come back, and on what terms. */
router.get('/bill/:saleId', async (req, res, next) => {
  try {
    res.json({ success: true, data: await eligibility((req as any).actor, req.params.saleId) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/returns/bill/:saleId/quote -- the exact refund for a selection. Writes nothing. */
router.post('/bill/:saleId/quote', async (req, res, next) => {
  try {
    const body = quoteSchema.safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    res.json({ success: true, data: await quote((req as any).actor, req.params.saleId, body.data.lines) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/returns/bill/:saleId -- record a return. Idempotent on onceKey. */
router.post('/bill/:saleId', async (req, res, next) => {
  try {
    const body = createReturnSchema.safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    const result = await createReturn((req as any).actor, req.params.saleId, body.data);
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/returns/bill/:saleId/exchange -- a return and a new bill, difference only. */
router.post('/bill/:saleId/exchange', async (req, res, next) => {
  try {
    const body = createExchangeSchema.safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    const result = await createExchange((req as any).actor, req.params.saleId, body.data);
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/returns/:id -- one credit note, as it prints. */
router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await getReturn((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
