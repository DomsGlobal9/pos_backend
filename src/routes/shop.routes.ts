import { Router } from 'express';
import { forTill, setUpiId } from '../services/shop';
import { devActor } from '../middleware/dev-actor.middleware';

const router = Router();
router.use(devActor);

/** GET /api/v1/shop -- everything the till needs before its first scan. */
router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await forTill((req as any).actor) });
  } catch (error) {
    next(error);
  }
});

/** PUT /api/v1/shop/upi -- POS-PAY-012. `{ upiId }`, or null to stop offering a QR. Owner-only. */
router.put('/upi', async (req, res, next) => {
  try {
    const upiId = req.body?.upiId === null ? null : String(req.body?.upiId ?? '');
    res.json({ success: true, data: await setUpiId((req as any).actor, upiId) });
  } catch (error) {
    next(error);
  }
});

export default router;
