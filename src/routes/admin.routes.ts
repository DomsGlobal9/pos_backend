import { Router } from 'express';
import { z } from 'zod';
import { setPin } from '../services/approvals';
import { recent } from '../services/audit';
import { forbidden, badRequest } from '../utils/httpError';
import { may, PERMISSIONS } from '../types/actor';
import { devActor } from '../middleware/dev-actor.middleware';

/**
 * Owner and manager things. Never on a cashier's screen.
 *
 * POS-APR-006: a refusal here is one plain sentence. A cashier who wanders into a settings URL
 * sees "only the owner can change PINs", never a 403 or a stack trace.
 */
const router = Router();
router.use(devActor);

/** POST /api/v1/admin/pin -- set a manager's approval PIN. Owner only (settings:manage). */
router.post('/pin', async (req, res, next) => {
  try {
    const actor = (req as any).actor;
    if (!may(actor, PERMISSIONS.SETTINGS)) {
      throw forbidden('Only the owner can set approval PINs.', { code: 'NOT_PERMITTED' });
    }
    const body = z.object({ userId: z.string().min(1), pin: z.string() }).safeParse(req.body);
    if (!body.success) throw badRequest('Choose a person and a PIN.');
    res.json({ success: true, data: await setPin(actor, body.data.userId, body.data.pin) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/admin/audit -- POS-CORE-010.
 *
 * Owner and managers. A cashier has no business reading who approved what -- and more to the
 * point, the list names the people who did.
 */
router.get('/audit', async (req, res, next) => {
  try {
    const actor = (req as any).actor;
    if (!may(actor, PERMISSIONS.SETTINGS) && !may(actor, PERMISSIONS.DISCOUNT_OVER_LIMIT)) {
      throw forbidden('Only a manager or the owner can see this.', { code: 'NOT_PERMITTED' });
    }
    res.json({ success: true, data: await recent(actor) });
  } catch (error) {
    next(error);
  }
});

export default router;
