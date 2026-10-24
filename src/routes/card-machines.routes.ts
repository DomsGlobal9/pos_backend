import { Router } from 'express';
import { z } from 'zod';
import { devActor } from '../middleware/dev-actor.middleware';
import { badRequest } from '../utils/httpError';
import { listMachines, addMachine, changeMachine, startRequest, requestStatus, cancelRequest } from '../services/card-machines';

/** Card machines the till sends the amount to (24 Oct). Setting them up is the owner's; see services/card-machines. */
const router = Router();
router.use(devActor);

const handle = (fn: (req: any) => Promise<unknown>) => async (req: any, res: any, next: any) => {
  try { res.json({ success: true, data: await fn(req) }); } catch (error) { next(error); }
};

const fields = z.record(z.string(), z.string().max(200)).refine(o => Object.keys(o).length <= 10, 'Too many fields.');

/** GET /api/v1/card-machines?all=1 -- names to choose from; never an id or key of the provider's. */
router.get('/', handle(req => listMachines(req.actor, req.query.all === '1')));

router.post('/', handle(req => {
  const b = z.object({
    name: z.string().max(60), provider: z.string().max(30), testMode: z.boolean().optional(),
    counterId: z.string().max(60).nullable().optional(), config: fields
  }).safeParse(req.body);
  if (!b.success) throw badRequest('Say the machine\'s name, its company and its ids.');
  return addMachine(req.actor, b.data);
}));

router.patch('/:id', handle(req => {
  const b = z.object({
    name: z.string().max(60).optional(), testMode: z.boolean().optional(), active: z.boolean().optional(),
    counterId: z.string().max(60).nullable().optional(), config: fields.optional()
  }).safeParse(req.body);
  if (!b.success) throw badRequest('That change could not be read.');
  return changeMachine(req.actor, req.params.id, b.data);
}));

/** POST /api/v1/card-machines/requests -- send this amount to the machine. Always 200; ok:false says why not. */
router.post('/requests', handle(req => {
  const b = z.object({
    machineId: z.string().min(1).max(60), amountPaise: z.number().int().positive().max(2_000_000_000),
    idempotencyKey: z.string().min(8).max(120), billRef: z.string().max(40).optional()
  }).safeParse(req.body);
  if (!b.success) throw badRequest('Say which machine and how much.');
  return startRequest(req.actor, b.data);
}));

router.get('/requests/:id', handle(req => requestStatus(req.actor, req.params.id)));
router.post('/requests/:id/cancel', handle(req => cancelRequest(req.actor, req.params.id)));

export default router;
