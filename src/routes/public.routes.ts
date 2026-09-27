import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { publicReceipt, publicPdf } from '../services/receipts';

/**
 * What the world can reach without signing in: the digital receipt, by its token. POS-RCPT-009.
 *
 * No devActor, no session -- the token IS the permission, the same way the paper is. Rate-limited
 * hard, so nobody can walk the token space: 24 random characters is not guessable, and this makes
 * sure nobody gets to try.
 */
const router = Router();

router.use(rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Wait a minute and open the link again.' }
}));

/** GET /api/v1/public/receipts/:token */
router.get('/receipts/:token', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({ success: true, data: await publicReceipt(req.params.token) });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/public/receipts/:token/pdf */
router.get('/receipts/:token/pdf', async (req, res, next) => {
  try {
    const { pdf, invoiceNo } = await publicPdf(req.params.token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoiceNo.replace(/[^\w-]+/g, '-')}.pdf"`);
    res.send(pdf);
  } catch (error) {
    next(error);
  }
});

export default router;
