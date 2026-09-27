import { Router } from 'express';
import { z } from 'zod';
import { awaitingCheck, resolve } from '../services/payments';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

const router = Router();
router.use(devActor);

/** GET /api/v1/payments/awaiting-check -- POS-PAY-011, the WF-PAY-02 worklist. */
router.get('/awaiting-check', async (req, res, next) => {
  try {
    res.json({ success: true, data: await awaitingCheck((req as any).actor) });
  } catch (error) {
    next(error);
  }
});

const resolution = z.object({
  /** What the bank actually said. Not a guess. */
  arrived: z.boolean(),
  reference: z.string().trim().max(64).optional(),
  note: z.string().trim().max(280).optional()
});

/** POST /api/v1/payments/:id/resolve -- settle one unconfirmed payment. */
router.post('/:id/resolve', async (req, res, next) => {
  try {
    const parsed = resolution.safeParse(req.body);
    if (!parsed.success) throw badRequest('Say whether the money arrived.');
    res.json({ success: true, data: await resolve((req as any).actor, req.params.id, parsed.data) });
  } catch (error) {
    next(error);
  }
});

export default router;
