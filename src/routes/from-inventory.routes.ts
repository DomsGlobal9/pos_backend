import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { enableFromInventory, disableFromInventory, statusFromInventory, ownerLinkFromInventory } from '../services/module-service/inventory-door.service';

/**
 * INVENTORY SETTING POS UP FOR A CLIENT (25 Nov). Signed by Inventory's own service key; see
 * services/module-service/inventory-door.service.ts. Never called by a shop or a browser.
 *
 *   POST /api/v1/from-inventory/pos/enable       { shopName, tillKey, owner: { name, email?, phone? } }
 *   POST /api/v1/from-inventory/pos/disable
 *   GET  /api/v1/from-inventory/pos/status
 *   POST /api/v1/from-inventory/pos/owner-link   { reset?: true }
 */
const router = Router();

// ScaleEzy never switches sixty shops in a minute; a tight limit makes guessing hopeless.
router.use(rateLimit({
  windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message: 'Too many calls in one minute. Wait a minute and try again.', details: { code: 'RATE_LIMITED' } }
}));

const handle = (run: (req: Request) => Promise<any>, status = (_r: any) => 200) => async (req: Request, res: Response, next: NextFunction) => {
  try { const r = await run(req); res.status(status(r)).json({ success: true, apiVersion: 1, data: r }); } catch (e) { next(e); }
};

router.post('/pos/enable', handle(req => enableFromInventory(req.headers.authorization, req.body ?? {}), r => (r.made ? 201 : 200)));
router.post('/pos/disable', handle(req => disableFromInventory(req.headers.authorization)));
router.get('/pos/status', handle(req => statusFromInventory(req.headers.authorization)));
router.post('/pos/owner-link', handle(req => ownerLinkFromInventory(req.headers.authorization, req.body ?? {})));

export default router;
