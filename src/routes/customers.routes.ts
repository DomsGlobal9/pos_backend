import { Router } from 'express';
import { z } from 'zod';
import { findByPhone, findOrCreate, search, detail, updateDetails } from '../services/customers';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

const router = Router();
router.use(devActor);

/** GET /api/v1/customers?q= -- POS-CUST-007. One box for a name or a number. */
router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await search((req as any).actor, req.query.q) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/customers/by-phone/:phone -- POS-CUST-002.
 *
 * 200 with null when nobody matches. "We have not met this person" is an ordinary answer at a
 * counter, and a 404 would make the till treat it as a failure.
 */
router.get('/by-phone/:phone', async (req, res, next) => {
  try {
    const found = await findByPhone((req as any).actor, req.params.phone);
    res.json({ success: true, data: found });
  } catch (error) {
    next(error);
  }
});

const quickCreate = z.object({
  phone: z.string().min(1, 'Enter a phone number'),
  name: z.string().trim().max(120).optional(),
  gstin: z.string().trim().max(20).optional(),
  note: z.string().trim().max(280).optional(),
  /** Only ever true from here. A screen without the tick is not the customer saying no. */
  marketingConsent: z.boolean().optional()
});

/** POST /api/v1/customers -- POS-CUST-004. Find or create, so a race ends with one customer. */
router.post('/', async (req, res, next) => {
  try {
    const parsed = quickCreate.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const result = await findOrCreate((req as any).actor, parsed.data);
    res.status(result.created ? 201 : 200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/customers/:id -- POS-CUST-008, -009, -010. */
router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await detail((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** PATCH /api/v1/customers/:id -- name, GSTIN and address, for B2B tax invoices. */
router.patch('/:id', async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().max(120).nullable().optional(),
      gstin: z.string().max(20).nullable().optional(),
      address: z.string().max(300).nullable().optional()
    }).safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    res.json({ success: true, data: await updateDetails((req as any).actor, req.params.id, body.data) });
  } catch (error) {
    next(error);
  }
});

export default router;
