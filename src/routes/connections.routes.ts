import { Router } from 'express';
import { z } from 'zod';
import { devActor } from '../middleware/dev-actor.middleware';
import { badRequest } from '../utils/httpError';
import * as apiKeys from '../services/api-keys';
import * as webhooks from '../services/webhooks';
import { importSheet, templateCsv } from '../services/item-import';
import { salesCsv, salesXlsx } from '../services/exports';

/**
 * The owner's Connections screen. WF-INTEGRATIONS-01.
 *
 *   API keys      make (shown once), list, revoke                   POS-API-001
 *   Webhooks      add (secret shown once), change, remove, test,     POS-WEB-001, -006
 *                 what happened to each notice, send again
 *   Items         template, check a sheet, import it                 POS-EXP-001, POS-STAND-002
 *   Export        sales as CSV or Excel for a date range             POS-EXP-002
 */
const router = Router();
router.use(devActor);

const actor = (req: any) => req.actor;
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data });
const body = <T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
  return parsed.data;
};

// ---- API keys
router.get('/api-keys', async (req, res, next) => { try { ok(res, await apiKeys.list(actor(req))); } catch (e) { next(e); } });
router.post('/api-keys', async (req, res, next) => {
  try {
    const b = body(z.object({ name: z.string().max(60), scopes: z.array(z.string()).max(10) }), req.body);
    ok(res, await apiKeys.create(actor(req), b), 201);
  } catch (e) { next(e); }
});
router.post('/api-keys/:id/revoke', async (req, res, next) => { try { ok(res, await apiKeys.revoke(actor(req), req.params.id)); } catch (e) { next(e); } });

// ---- Webhooks
router.get('/webhooks', async (req, res, next) => { try { ok(res, await webhooks.list(actor(req))); } catch (e) { next(e); } });
router.post('/webhooks', async (req, res, next) => {
  try {
    const b = body(z.object({ name: z.string().max(60), url: z.string().max(500), events: z.array(z.string()).max(10).optional() }), req.body);
    ok(res, await webhooks.create(actor(req), b), 201);
  } catch (e) { next(e); }
});
router.patch('/webhooks/:id', async (req, res, next) => {
  try {
    const b = body(z.object({ name: z.string().max(60).optional(), url: z.string().max(500).optional(), events: z.array(z.string()).max(10).optional(), active: z.boolean().optional() }), req.body);
    ok(res, await webhooks.update(actor(req), req.params.id, b));
  } catch (e) { next(e); }
});
router.delete('/webhooks/:id', async (req, res, next) => { try { ok(res, await webhooks.remove(actor(req), req.params.id)); } catch (e) { next(e); } });
router.post('/webhooks/:id/test', async (req, res, next) => { try { ok(res, await webhooks.ping(actor(req), req.params.id)); } catch (e) { next(e); } });
router.get('/webhooks/:id/deliveries', async (req, res, next) => {
  try { ok(res, await webhooks.deliveries(actor(req), req.params.id, Number(req.query.take) || 50)); } catch (e) { next(e); }
});
router.post('/deliveries/:id/resend', async (req, res, next) => { try { ok(res, await webhooks.resend(actor(req), req.params.id)); } catch (e) { next(e); } });

// ---- Items from a spreadsheet
router.get('/items/template.csv', (_req, res) => {
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="items-template.csv"');
  res.send(templateCsv());
});
router.post('/items/import', async (req, res, next) => {
  try {
    const b = body(z.object({ file: z.object({ name: z.string().max(200), base64: z.string().max(8_000_000) }), commit: z.boolean().optional() }), req.body);
    ok(res, await importSheet(actor(req), b.file, b.commit === true));
  } catch (e) { next(e); }
});

// ---- Sales for the accountant
const range = (q: any) => body(z.object({ from: z.string(), to: z.string() }), q);
router.get('/exports/sales.csv', async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const csv = await salesCsv(actor(req), from, to);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="sales-${from}-to-${to}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});
router.get('/exports/sales.xlsx', async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const buf = await salesXlsx(actor(req), from, to);
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', `attachment; filename="sales-${from}-to-${to}.xlsx"`);
    res.send(buf);
  } catch (e) { next(e); }
});

export default router;
