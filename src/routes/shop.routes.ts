import { Router } from 'express';
import { forTill, setUpiId, setLogo, setGstRegistration, setPaymentMethods, setShopDetails, setIdleSignOut } from '../services/shop';
import { whatsappStatus, linkWhatsApp, unlinkWhatsApp } from '../services/receipt-send';
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

/**
 * PUT /api/v1/shop/details -- the shop's name, address, phone, GSTIN, bill footer, cashier discount limit
 * and return window (28 Oct). Owner-only; not while connected. Only the fields sent are changed.
 */
/** PUT /api/v1/shop/idle-sign-out -- `{ minutes }`: 10, 30, 60, 240, or 0 for never (12 Nov). Owner-only. */
router.put('/idle-sign-out', async (req, res, next) => {
  try {
    res.json({ success: true, data: await setIdleSignOut((req as any).actor, req.body?.minutes) });
  } catch (error) {
    next(error);
  }
});

router.put('/details', async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const pick = ['shopName', 'address', 'phone', 'gstin', 'receiptFooter', 'manualDiscountMaxPercent', 'returnWindowDays'];
    res.json({ success: true, data: await setShopDetails((req as any).actor, Object.fromEntries(pick.filter(k => k in b).map(k => [k, b[k]]))) });
  } catch (error) {
    next(error);
  }
});

/*
 * The shop's own WhatsApp number, linked from POS (25 Nov). Owner or manager. The QR and the code pass
 * straight through: no-store, never logged (services/receipt-send/whatsapp-link.service.ts).
 */
router.use('/whatsapp', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/** GET /api/v1/shop/whatsapp[?fresh=1] -- switched on or not, the number (last digits) and its state. */
router.get('/whatsapp', async (req, res, next) => {
  try {
    res.json({ success: true, data: await whatsappStatus((req as any).actor, { fresh: req.query.fresh === '1' }) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/shop/whatsapp/link -- `{ method: 'qr' }` or `{ method: 'code', phone }`. Answers a QR or a code. */
router.post('/whatsapp/link', async (req, res, next) => {
  try {
    res.json({ success: true, data: await linkWhatsApp((req as any).actor, req.body ?? {}) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/shop/whatsapp/unlink -- the shop's number unlinked, for every ScaleEzy app. */
router.post('/whatsapp/unlink', async (req, res, next) => {
  try {
    res.json({ success: true, data: await unlinkWhatsApp((req as any).actor) });
  } catch (error) {
    next(error);
  }
});

export default router;
