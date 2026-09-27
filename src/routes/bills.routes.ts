import { Router } from 'express';
import { z } from 'zod';
import { list, recordPrint } from '../services/bills';
import { receiptLink, pdfFor } from '../services/receipts';
import { sendReceipt, sendsFor } from '../services/receipt-send';
import { getSale } from '../services/sale';
import { badRequest } from '../utils/httpError';
import { devActor } from '../middleware/dev-actor.middleware';

const router = Router();
router.use(devActor);

const filters = z.object({
  q: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  method: z.enum(['CASH', 'UPI', 'CARD', 'CREDIT', 'POINTS', 'BALANCE']).optional(),
  status: z.enum(['COMPLETED', 'BALANCE_DUE', 'RETURNED', 'PENDING_SYNC']).optional(),
  after: z.string().min(1).optional()
});

/** GET /api/v1/bills -- POS-SALE-001..006. */
router.get('/', async (req, res, next) => {
  try {
    const parsed = filters.safeParse(req.query);
    if (!parsed.success) throw badRequest('That filter is not something this list understands.');
    res.json({ success: true, data: await list((req as any).actor, parsed.data) });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/bills/:id -- POS-SALE-007..009. The same shape a receipt reads. */
router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await getSale((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/bills/:id/printed -- POS-RCPT-003, -004. Returns which copy this is. */
router.post('/:id/printed', async (req, res, next) => {
  try {
    res.json({ success: true, data: await recordPrint((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/bills/:id/receipt.pdf -- POS-RCPT-002. The same document WhatsApp sends. */
router.get('/:id/receipt.pdf', async (req, res, next) => {
  try {
    const { pdf, invoiceNo } = await pdfFor((req as any).actor, req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoiceNo.replace(/[^\w-]+/g, '-')}.pdf"`);
    res.send(pdf);
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/bills/:id/receipt-link -- POS-RCPT-009. The digital receipt's address. */
router.post('/:id/receipt-link', async (req, res, next) => {
  try {
    res.json({ success: true, data: await receiptLink((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

/** POST /api/v1/bills/:id/send -- POS-RCPT-006. One press, one message, to the bill's own customer. */
router.post('/:id/send', async (req, res, next) => {
  try {
    const body = z.object({ onceKey: z.string().min(8).max(100), channel: z.enum(['WHATSAPP', 'EMAIL', 'SMS']).optional() }).safeParse(req.body);
    if (!body.success) throw badRequest('Say how to send the receipt.');
    const result = await sendReceipt((req as any).actor, req.params.id, body.data);
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/** GET /api/v1/bills/:id/sends -- what was sent, and how far it got. */
router.get('/:id/sends', async (req, res, next) => {
  try {
    res.json({ success: true, data: await sendsFor((req as any).actor, req.params.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
