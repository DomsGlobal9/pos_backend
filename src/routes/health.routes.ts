import { Router } from 'express';
import { health } from '../services/health';

const router = Router();

/**
 * GET /api/v1/health
 *
 * Unauthenticated on purpose: a health check that needs a token cannot be used by the thing that
 * needs it most, a load balancer. It returns nothing tenant-specific.
 *
 * 503 when the database is down, not 200 with a sad body -- the caller is usually a machine, and it
 * reads the status code.
 */
router.get('/', async (_req, res, next) => {
  try {
    const result = await health();
    res.status(result.ok ? 200 : 503).json({ success: result.ok, data: result });
  } catch (error) {
    next(error);
  }
});

export default router;
