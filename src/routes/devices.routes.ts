import { Router } from 'express';
import { z } from 'zod';
import { heartbeat, list, update } from '../services/devices';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

/** WF-DEVICES-01. POS-DEV-001..004. */
const router = Router();
router.use(devActor);

/** POST /api/v1/devices/heartbeat -- the till checks in: on open, every minute, after a print. */
router.post('/heartbeat', async (req: any, res, next) => {
  try {
    const body = z.object({
      deviceId: z.string(),
      name: z.string().max(60).optional(),
      appVersion: z.string().max(40).optional(),
      userAgent: z.string().max(300).optional(),
      capabilities: z.object({ camera: z.boolean().optional(), cameraScan: z.boolean().optional(), touch: z.boolean().optional(), screen: z.string().max(20).optional() }).optional(),
      printed: z.boolean().optional()
    }).safeParse(req.body);
    if (!body.success) throw badRequest('This device check-in could not be read.');
    res.json({ success: true, data: await heartbeat(req.actor, body.data) });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/devices */
router.get('/', async (req: any, res, next) => {
  try {
    res.json({ success: true, data: await list(req.actor) });
  } catch (error) {
    next(error);
  }
});

/** PATCH /api/v1/devices/:id -- name, counter, paper width. */
router.patch('/:id', async (req: any, res, next) => {
  try {
    const body = z.object({ name: z.string().optional(), counterId: z.string().nullable().optional(), paperWidthMm: z.number().int().optional() }).safeParse(req.body);
    if (!body.success) throw badRequest('That change could not be read.');
    res.json({ success: true, data: await update(req.actor, req.params.id, body.data) });
  } catch (error) {
    next(error);
  }
});

export default router;
