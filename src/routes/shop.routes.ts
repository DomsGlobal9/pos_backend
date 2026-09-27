import { Router } from 'express';
import { forTill } from '../services/shop';
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

export default router;
