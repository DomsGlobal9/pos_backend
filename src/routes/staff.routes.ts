import { Router } from 'express';
import { z } from 'zod';
import { devActor } from '../middleware/dev-actor.middleware';
import { badRequest } from '../utils/httpError';
import { list, create, update } from '../services/staff';

/** The owner's Staff screen. GET /staff, POST /staff, PATCH /staff/:id. */
const router = Router();
router.use(devActor);

const person = z.object({
  name: z.string().max(60).optional(),
  role: z.string().max(20).optional(),
  pin: z.string().max(8).optional(),
  email: z.string().max(120).nullable().optional(),
  phone: z.string().max(20).nullable().optional(),
  password: z.string().max(200).nullable().optional(),
  active: z.boolean().optional()
});
const body = (raw: unknown) => {
  const p = person.safeParse(raw);
  if (!p.success) throw badRequest(p.error.issues[0].message);
  return p.data;
};

router.get('/', async (req: any, res, next) => { try { res.json({ success: true, data: await list(req.actor) }); } catch (e) { next(e); } });
router.post('/', async (req: any, res, next) => { try { res.status(201).json({ success: true, data: await create(req.actor, body(req.body)) }); } catch (e) { next(e); } });
router.patch('/:id', async (req: any, res, next) => { try { res.json({ success: true, data: await update(req.actor, req.params.id, body(req.body)) }); } catch (e) { next(e); } });

export default router;
