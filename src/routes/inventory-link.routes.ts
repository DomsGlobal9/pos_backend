import { Router } from 'express';
import { z } from 'zod';
import { connect, disconnect, setWhenDown, retry, status, syncCatalogue, drain } from '../services/inventory-link';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

/**
 * The owner's Inventory link. POS-INV-001, -009, POS-SYNC-006. Contract:
 * docs/product/INVENTORY-CONTRACT.md. Owner-only except reading the status and refreshing items.
 */
const router = Router();
router.use(devActor);

const handle = (fn: (req: any) => Promise<unknown>) => async (req: any, res: any, next: any) => {
  try { res.json({ success: true, data: await fn(req) }); } catch (error) { next(error); }
};

/** GET /api/v1/inventory-link -- how the link is doing. Never includes the key. */
router.get('/', handle(req => status(req.actor)));

/** POST /api/v1/inventory-link/connect -- the key is tried against Inventory before it is kept. */
router.post('/connect', handle(req => {
  const body = z.object({ key: z.string().min(1, 'Paste the connection key'), baseUrl: z.string().optional(), whenDown: z.string().optional() })
    .safeParse(req.body);
  if (!body.success) throw badRequest(body.error.issues[0].message);
  return connect(req.actor, body.data);
}));

router.post('/disconnect', handle(req => disconnect(req.actor)));

router.post('/when-down', handle(req => {
  const body = z.object({ whenDown: z.string() }).safeParse(req.body);
  if (!body.success) throw badRequest('Choose what to do when Inventory cannot be reached.');
  return setWhenDown(req.actor, body.data.whenDown);
}));

/** POST /api/v1/inventory-link/retry -- a person fixed what stopped the queue; send now. */
router.post('/retry', handle(async req => {
  await retry(req.actor);
  const sent = await drain(req.actor.clientId);
  return { ...(await status(req.actor)), sent };
}));

/** POST /api/v1/inventory-link/sync-catalogue -- copy Inventory's items into the till. */
router.post('/sync-catalogue', handle(req => syncCatalogue(req.actor, { full: req.body?.full === true })));

export default router;
