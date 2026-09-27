import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { authenticate, mustHaveScope } from '../services/api-keys';
import { once, requestHash } from '../services/idempotency';
import { sales, sale, customer, dayFigures } from '../services/integration';
import { pushItems, patchItem } from '../services/item-import';

/**
 * The public API for a shop's own software. POS-API-001..007.
 *
 *     Authorization: Bearer pos_live_...
 *
 *     GET   /api/v1/integration/sales?from=YYYY-MM-DD&to=YYYY-MM-DD[&after=cursor][&limit=100]   sales:read
 *     GET   /api/v1/integration/sales/:invoiceNo        (URL-encoded: INV%2F2026-27%2F0012)      sales:read
 *     POST  /api/v1/integration/items                   { items: [...] }   Idempotency-Key       items:write
 *     PATCH /api/v1/integration/items/:code             { pricePaise?, qty?, name?, active? }    items:write
 *     GET   /api/v1/integration/customers?phone=98...                                            customers:read
 *     GET   /api/v1/integration/day-close/:date                                                  day:read
 *
 * Versioned in the path (v1) from the first call anyone makes; every answer says `apiVersion: 1`.
 * Errors are `{ success: false, message, details: { code } }` -- the code is stable, the sentence is
 * for a developer to read. Writes take an Idempotency-Key; a repeat gets the first answer back with
 * `Idempotent-Replayed: true`.
 *
 * The routes know HTTP; the services do not. Each reads the Actor the key became and calls the same
 * kind of service function the till uses (CONTRACTS §2).
 */
const router = Router();

// Per key, not per address: two shops behind one office router are two clients.
router.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.headers.authorization
    ? crypto.createHash('sha256').update(String(req.headers.authorization)).digest('hex')
    : ipKeyGenerator(req.ip ?? ''),
  message: { success: false, message: 'Too many requests for this key: at most 120 a minute. Wait and send again.', details: { code: 'RATE_LIMITED' } }
}));

router.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const header = String(req.headers.authorization ?? '');
    const key = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined);
    (req as any).actor = await authenticate(key);
    next();
  } catch (error) { next(error); }
});

const reply = (res: Response, status: number, data: unknown) => res.status(status).json({ success: true, apiVersion: 1, data });

router.get('/sales', async (req, res, next) => {
  try { reply(res, 200, await sales((req as any).actor, req.query as any)); } catch (e) { next(e); }
});

router.get('/sales/:invoiceNo', async (req, res, next) => {
  try { reply(res, 200, await sale((req as any).actor, req.params.invoiceNo)); } catch (e) { next(e); }
});

router.get('/customers', async (req, res, next) => {
  try { reply(res, 200, await customer((req as any).actor, req.query.phone as string | undefined)); } catch (e) { next(e); }
});

router.get('/day-close/:date', async (req, res, next) => {
  try { reply(res, 200, await dayFigures((req as any).actor, req.params.date)); } catch (e) { next(e); }
});

/** Writes: checked for the scope FIRST, so a key without it is refused before its Idempotency-Key is kept. */
async function write(req: Request, res: Response, next: NextFunction, run: () => Promise<unknown>) {
  try {
    const actor = (req as any).actor;
    mustHaveScope(actor, 'items:write');
    const key = req.headers['idempotency-key'] as string | undefined;
    const result = await once(actor.clientId, key, requestHash(req.method, req.originalUrl, req.body),
      async () => ({ status: 200, body: { success: true, apiVersion: 1, data: await run() } }));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (e) { next(e); }
}

router.post('/items', (req, res, next) => write(req, res, next, () => pushItems((req as any).actor, req.body?.items)));

router.patch('/items/:code', (req, res, next) => write(req, res, next, () => patchItem((req as any).actor, req.params.code, req.body ?? {})));

export default router;
