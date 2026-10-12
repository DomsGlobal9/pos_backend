import { Router } from 'express';
import { forTill, setUpiId, setLogo, setGstRegistration, setPaymentMethods } from '../services/shop';
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

/** PUT /api/v1/shop/payment-methods -- POS-SET-003. `{ methods: ['CASH','UPI','CARD'] }`, at least one. Owner-only. */
router.put('/payment-methods', async (req, res, next) => {
  try {
    res.json({ success: true, data: await setPaymentMethods((req as any).actor, req.body?.methods) });
  } catch (error) {
    next(error);
  }
});

/** PUT /api/v1/shop/logo -- POS-RCPT-011. `{ logoUrl }`: a JPEG data URL or https address, or null to remove. Owner-only. */
router.put('/logo', async (req, res, next) => {
  try {
    const logoUrl = req.body?.logoUrl === null ? null : String(req.body?.logoUrl ?? '');
    res.json({ success: true, data: await setLogo((req as any).actor, logoUrl) });
  } catch (error) {
    next(error);
  }
});

/** PUT /api/v1/shop/gst -- `{ registration }`: REGULAR | COMPOSITION | UNREGISTERED. Owner-only; not while connected. */
router.put('/gst', async (req, res, next) => {
  try {
    res.json({ success: true, data: await setGstRegistration((req as any).actor, String(req.body?.registration ?? '')) });
  } catch (error) {
    next(error);
  }
});

export default router;
