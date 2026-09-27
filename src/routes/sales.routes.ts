import { Router } from 'express';
import { z } from 'zod';
import { search } from '../services/items';
import { completeSale, getSale, completeSaleSchema } from '../services/sale';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

/**
 * The till's own endpoints.
 *
 * Routes are the ONLY place that knows an HTTP request exists. Each one pulls the Actor off the
 * request, validates the body, and calls a service function with plain arguments -- which is what
 * makes the public API for a client's own software (step 9) a key check in front of these same
 * service functions rather than a second implementation of all of them.
 */
const router = Router();

// Until sign-in is built, every request carries a development Actor. This middleware refuses to
// do anything outside development -- see the file for why that check is there and not elsewhere.
router.use(devActor);

/** GET /api/v1/sales/items?q=  -- find something to sell. */
router.get('/items', async (req, res, next) => {
  try {
    res.json({ success: true, data: await search((req as any).actor, req.query.q) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/sales  -- complete a sale. Idempotent on onceKey. */
router.post('/', async (req, res, next) => {
  try {
    const parsed = completeSaleSchema.safeParse(req.body);
    if (!parsed.success) {
      // One sentence, the first problem, named. A cashier cannot act on a list of zod issues.
      const issue = parsed.error.issues[0];
      throw badRequest(issue.message, { field: issue.path.join('.') });
    }
    const result = await completeSale((req as any).actor, parsed.data);
    // 200 rather than 201 on a replay: nothing was created the second time, and a till that
    // branches on the status code should see the difference.
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/sales/:id  -- one bill, as a receipt reads it. */
router.get('/:id', async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    res.json({ success: true, data: await getSale((req as any).actor, id) });
  } catch (error) {
    next(error);
  }
});

export default router;
