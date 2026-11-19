import { Router } from 'express';
import { verifyCrm, applyCrmEvent } from '../services/crm/events.service';

const router = Router();

/**
 * POST /api/v1/webhooks/crm/events -- ScaleEzy CRM's signed events (services/crm/events.service.ts).
 *
 * Not a person's route: no sign-in. CRM proves it is CRM by signing the exact bytes. Answered 2xx once
 * applied (or already applied, or about a customer this till does not have), so CRM never retries those.
 */
router.post('/events', async (req, res) => {
  const verdict = verifyCrm(req.header('x-crm-signature'), (req as any).rawBody);
  if (verdict === 'off') return res.status(503).json({ success: false, message: 'This till does not take events from CRM yet (CRM_WEBHOOK_SECRET is not set).' });
  if (verdict === 'stale') return res.status(400).json({ success: false, reason: 'stale_timestamp', message: 'This event is more than 5 minutes old, or the clock of the sender is off.' });
  if (verdict !== 'ok') return res.status(401).json({ success: false, message: 'The signature does not match.' });
  const e = req.body;
  if (!e || typeof e.id !== 'string' || !e.id || typeof e.kind !== 'string' || typeof e.clientId !== 'string' || (req.header('x-crm-event-id') && req.header('x-crm-event-id') !== e.id)) {
    return res.status(400).json({ success: false, message: 'Send { id, kind, clientId, subjectId, occurredAt, payload }, with X-CRM-Event-Id the same id.' });
  }
  try {
    const r = await applyCrmEvent(e);
    res.status(200).json({ success: true, data: r });
  } catch (error) {
    console.error('[crm] could not apply an event', (error as Error).message);
    res.status(503).json({ success: false, message: 'Not applied just now; send it again.' });
  }
});

export default router;
