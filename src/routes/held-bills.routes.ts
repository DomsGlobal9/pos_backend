import { Router } from 'express';
import { z } from 'zod';
import { park, list, recall, discard } from '../services/held-bills';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

const router = Router();
router.use(devActor);

/** GET /api/v1/held-bills -- WF-HELD-01. */
router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await list((req as any).actor) });
  } catch (error) {
    next(error);
  }
});

const parking = z.object({
  counterId: z.string().min(1),
  label: z.string().trim().max(60).optional(),
  payload: z.object({
    lines: z.array(z.object({ id: z.string().min(1), qty: z.number().int().positive() }).passthrough()),
    customer: z.object({ id: z.string() }).passthrough().nullable().optional(),
    billDiscountPaise: z.number().int().nonnegative().optional(),
    onceKey: z.string().optional()
  })
});

/** POST /api/v1/held-bills -- POS-SELL-019. */
router.post('/', async (req, res, next) => {
  try {
    const body = parking.safeParse(req.body);
    if (!body.success) throw badRequest('There is nothing on this bill to park.');
    res.status(201).json({ success: true, data: await park((req as any).actor, body.data as any) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/held-bills/:id/recall -- POS-SELL-020. One person gets it. */
router.post('/:id/recall', async (req, res, next) => {
  try {
    res.json({ success: true, data: await recall((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/v1/held-bills/:id -- throw a parked bill away. */
router.delete('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await discard((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
