import { Router } from 'express';
import { z } from 'zod';
import { current, open, move, close } from '../services/shifts';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

/** WF-SHIFT-01 and WF-CASH-01. One drawer per counter, from float in to count out. */
const router = Router();
router.use(devActor);

const paise = z.number().int('Amounts are in paise, as whole numbers');

/** GET /api/v1/shifts/counter/:counterId -- the counter's open shift, figures and recent closes. */
router.get('/counter/:counterId', async (req, res, next) => {
  try {
    res.json({ success: true, data: await current((req as any).actor, req.params.counterId) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/shifts -- POS-SHIFT-001. */
router.post('/', async (req, res, next) => {
  try {
    const body = z.object({ counterId: z.string().min(1), openingCashPaise: paise.nonnegative('The float cannot be negative') })
      .safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    res.status(201).json({ success: true, data: await open((req as any).actor, body.data) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/shifts/cash -- POS-SHIFT-003, -004. Idempotent on onceKey. */
router.post('/cash', async (req, res, next) => {
  try {
    const body = z.object({
      counterId: z.string().min(1),
      direction: z.enum(['IN', 'OUT']),
      amountPaise: paise.positive('Enter an amount'),
      reason: z.string().trim().max(200),
      onceKey: z.string().min(8).max(100),
      approval: z.object({ pin: z.string().min(1), reason: z.string().trim().min(1) }).optional()
    }).safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    const result = await move((req as any).actor, body.data);
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/shifts/:id/close -- POS-SHIFT-006..008. Blind count; the difference sticks. */
router.post('/:id/close', async (req, res, next) => {
  try {
    const body = z.object({ countedCashPaise: paise.nonnegative('Enter what you counted'), note: z.string().max(280).optional() })
      .safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    res.json({ success: true, data: await close((req as any).actor, req.params.id, body.data) });
  } catch (error) {
    next(error);
  }
});

export default router;
