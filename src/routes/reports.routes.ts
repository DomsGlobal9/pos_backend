import { Router } from 'express';
import { report } from '../services/reports';
import { devActor } from '../middleware/dev-actor.middleware';

/** WF-REPORTS-01. GET /api/v1/reports?from=YYYY-MM-DD&to=YYYY-MM-DD */
const router = Router();
router.use(devActor);

router.get('/', async (req: any, res, next) => {
  try {
    const q = { from: req.query.from ? String(req.query.from) : undefined, to: req.query.to ? String(req.query.to) : undefined };
    res.json({ success: true, data: await report(req.actor, q) });
  } catch (error) {
    next(error);
  }
});

export default router;
