import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { createShop } from '../services/shop-setup';

/**
 * ScaleEzy's own door into the POS: setting up a new shop. Header x-platform-key must equal
 * PLATFORM_SETUP_KEY; with that unset, this route does not exist (404). Never used by a shop.
 */
const router = Router();

// The setup key is long and random, but this door now has a web page in front of it: a tight
// limit makes guessing it hopeless, and ScaleEzy never sets up ten shops in a minute.
router.use(rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many tries in one minute. Wait a minute and try again.' }
}));

router.use((req, res, next) => {
  const expected = env.PLATFORM_SETUP_KEY;
  if (!expected) return res.status(404).json({ success: false, message: 'Not found.' });
  const given = Buffer.from(String(req.headers['x-platform-key'] ?? ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ success: false, message: 'That setup key is not right.' });
  }
  next();
});

/** POST /api/v1/platform/shops -- see services/shop-setup for the body. */
router.post('/shops', async (req, res, next) => {
  try { res.status(201).json({ success: true, data: await createShop(req.body ?? {}) }); } catch (e) { next(e); }
});

export default router;
