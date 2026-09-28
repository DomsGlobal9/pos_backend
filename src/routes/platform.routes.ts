import { Router } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { createShop } from '../services/shop-setup';

/**
 * ScaleEzy's own door into the POS: setting up a new shop. Header x-platform-key must equal
 * PLATFORM_SETUP_KEY; with that unset, this route does not exist (404). Never used by a shop.
 */
const router = Router();

router.use((req, res, next) => {
  const expected = env.PLATFORM_SETUP_KEY;
  if (!expected) return res.status(404).json({ success: false, message: 'Not found.' });
  const given = Buffer.from(String(req.headers['x-platform-key'] ?? ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ success: false, message: 'Not allowed.' });
  }
  next();
});

/** POST /api/v1/platform/shops -- see services/shop-setup for the body. */
router.post('/shops', async (req, res, next) => {
  try { res.status(201).json({ success: true, data: await createShop(req.body ?? {}) }); } catch (e) { next(e); }
});

export default router;
