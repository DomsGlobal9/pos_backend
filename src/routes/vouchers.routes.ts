import { Router } from 'express';
import { z } from 'zod';
import { devActor } from '../middleware/dev-actor.middleware';
import { badRequest } from '../utils/httpError';
import { paymentSchema } from '../services/sale/sale.schema';
import { sellVoucher, checkVoucher } from '../services/vouchers';

/** Gift vouchers at the till (16 Oct). Inventory holds them; see services/vouchers. */
const router = Router();
router.use(devActor);

/** POST /api/v1/vouchers -- sell one: the money is taken, then Inventory makes the code. */
router.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      onceKey: z.string().min(8).max(100),
      amountPaise: z.number().int().positive().max(2_000_000_000),
      counterId: z.string().min(1).optional(),
      payments: z.array(paymentSchema).min(1).max(6),
      buyer: z.object({ name: z.string().max(80).optional(), phone: z.string().max(20).optional() }).optional()
    }).safeParse(req.body);
    if (!body.success) throw badRequest(body.error.issues[0].message);
    res.json({ success: true, data: await sellVoucher((req as any).actor, body.data) });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/vouchers/:code?billPaise= -- what it is good for on this bill. */
router.get('/:code', async (req, res, next) => {
  try {
    const bill = req.query.billPaise === undefined ? undefined : Number(req.query.billPaise);
    if (bill !== undefined && (!Number.isInteger(bill) || bill < 0)) throw badRequest('Say the bill in whole paise.');
    res.json({ success: true, data: await checkVoucher((req as any).actor, req.params.code, bill) });
  } catch (error) {
    next(error);
  }
});

export default router;
