import { Router } from 'express';
import { summary } from '../services/home';
import { devActor } from '../middleware/dev-actor.middleware';

const router = Router();
router.use(devActor);

/** GET /api/v1/home/summary -- POS-HOME-002, -003, -006, -007. */
router.get('/summary', async (req, res, next) => {
  try {
    res.json({ success: true, data: await summary((req as any).actor) });
  } catch (error) {
    next(error);
  }
});

export default router;
