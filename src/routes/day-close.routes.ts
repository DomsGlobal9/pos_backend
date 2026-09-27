import { Router } from 'express';
import { z } from 'zod';
import { day, closeDay } from '../services/day-close';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

/** WF-DAY-01. POS-DAY-001..005. */
const router = Router();
router.use(devActor);

/** GET /api/v1/day-close/:date -- live figures, and the frozen close if there is one. */
router.get('/:date', async (req, res, next) => {
  try {
    res.json({ success: true, data: await day((req as any).actor, req.params.date) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/day-close/:date -- close it. `acceptOpenShifts: true` is the explicit "close anyway"
 * when a shift is still open; without it the request is refused, naming the shifts.
 */
router.post('/:date', async (req, res, next) => {
  try {
    const body = z.object({ acceptOpenShifts: z.boolean().optional(), note: z.string().max(280).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) throw badRequest(body.error.issues[0].message);
    res.json({ success: true, data: await closeDay((req as any).actor, req.params.date, body.data) });
  } catch (error) {
    next(error);
  }
});

export default router;
