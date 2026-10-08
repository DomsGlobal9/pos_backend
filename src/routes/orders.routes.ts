import { Router } from 'express';
import { z } from 'zod';
import { list, collect, writeOff, markReady, handOver } from '../services/orders';
import { paymentSchema } from '../services/sale/sale.schema';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

const router = Router();
router.use(devActor);

const tabs = z.enum(['ALL', 'WAITING', 'READY', 'DUE', 'COMPLETE']).default('ALL');

/** GET /api/v1/orders?tab=&q= -- WF-ORDERS-01. */
router.get('/', async (req, res, next) => {
  try {
    const tab = tabs.safeParse(req.query.tab ?? 'ALL');
    if (!tab.success) throw badRequest('That is not one of the order lists.');
    res.json({ success: true, data: await list((req as any).actor, tab.data, req.query.q) });
  } catch (error) {
    next(error);
  }
});

const collection = z.object({
  onceKey: z.string().min(8),
  payments: z.array(paymentSchema).min(1, 'Nothing has been paid').max(6),
  /** Which till the money was taken at, so it counts in that drawer. POS-SHIFT-005. */
  counterId: z.string().min(1).optional(),
  /** A manager's yes, when the payment's reference is already on another bill. */
  approval: z.object({ pin: z.string().min(1), reason: z.string() }).optional()
});

/** POST /api/v1/orders/:id/collect -- POS-ORD-012. Idempotent on onceKey. */
router.post('/:id/collect', async (req, res, next) => {
  try {
    const body = collection.safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    const result = await collect((req as any).actor, req.params.id, body.data);
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/orders/:id/write-off -- give up on what is owed. Idempotent on onceKey; a cashier needs a manager. */
const writingOff = z.object({
  onceKey: z.string().min(8).max(100),
  reason: z.string().max(200),
  approval: z.object({ pin: z.string().min(1), reason: z.string() }).optional()
});
router.post('/:id/write-off', async (req, res, next) => {
  try {
    const body = writingOff.safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    const result = await writeOff((req as any).actor, req.params.id, body.data);
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/orders/:id/ready -- POS-ORD-007. Pressing it twice is fine. */
router.post('/:id/ready', async (req, res, next) => {
  try {
    res.json({ success: true, data: await markReady((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/orders/:id/hand-over -- POS-ORD-013, -014.
 *
 * `acceptDue: true` is the explicit "yes, hand it over with money owed". Without it, an order with
 * a balance is refused with the amount, which the screen turns into the warning.
 */
router.post('/:id/hand-over', async (req, res, next) => {
  try {
    const body = z.object({ acceptDue: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) throw badRequest('Say whether to hand over with money owed.');
    res.json({ success: true, data: await handOver((req as any).actor, req.params.id, body.data) });
  } catch (error) {
    next(error);
  }
});

export default router;
