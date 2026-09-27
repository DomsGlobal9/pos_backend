import { Router } from 'express';
import { z } from 'zod';
import { list, recordPrint } from '../services/bills';
import { getSale } from '../services/sale';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

const router = Router();
router.use(devActor);

const filters = z.object({
  q: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  method: z.enum(['CASH', 'UPI', 'CARD', 'CREDIT', 'POINTS', 'BALANCE']).optional(),
  status: z.enum(['COMPLETED', 'BALANCE_DUE', 'RETURNED', 'PENDING_SYNC']).optional(),
  after: z.string().min(1).optional()
});

/** GET /api/v1/bills -- POS-SALE-001..006. */
router.get('/', async (req, res, next) => {
  try {
    const parsed = filters.safeParse(req.query);
    if (!parsed.success) throw badRequest('That filter is not something this list understands.');
    res.json({ success: true, data: await list((req as any).actor, parsed.data) });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/bills/:id -- POS-SALE-007..009. The same shape a receipt reads. */
router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await getSale((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/bills/:id/printed -- POS-RCPT-003, -004. Returns which copy this is. */
router.post('/:id/printed', async (req, res, next) => {
  try {
    res.json({ success: true, data: await recordPrint((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
