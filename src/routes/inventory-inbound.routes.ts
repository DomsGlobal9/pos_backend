import { Router } from 'express';
import { verifyPush, pushBody, storePush, workPushes } from '../services/inventory-link/inbound.service';

const router = Router();

/**
 * POST /api/v1/inventory/events -- Inventory's pushes (12 Nov, PLAN-live step 3).
 *
 * Not a person's route: no cookie or token. Inventory proves it is Inventory by signing the exact
 * bytes: x-inventory-timestamp (unix seconds) and x-inventory-signature = sha256=<HMAC of
 * "timestamp.rawBody" with POS_EVENTS_SECRET>, five minutes either way. Stored, answered 202, worked
 * after. A shop the till does not know is answered 202 too, so Inventory does not retry it forever.
 */
router.post('/events', async (req, res) => {
  const verdict = verifyPush(req.header('x-inventory-timestamp'), req.header('x-inventory-signature'), (req as any).rawBody);
  if (verdict === 'off') return res.status(503).json({ success: false, message: 'This till does not take pushes from Inventory yet (POS_EVENTS_SECRET is not set).' });
  if (verdict === 'stale') return res.status(400).json({ success: false, reason: 'stale_timestamp', message: 'This delivery is too old, or the sender’s clock is off by more than 5 minutes.' });
  if (verdict !== 'ok') return res.status(401).json({ success: false, message: 'The signature does not match.' });

  const body = pushBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ success: false, message: body.error.issues[0]?.message ?? 'Send { clientId, events: [...] }.' });
  try {
    const stored = await storePush(body.data);
    res.status(202).json({ success: true, data: { received: body.data.events.length, new: stored } });
  } catch (error) {
    console.error('[inventory-inbound] could not store a push', error);
    return res.status(503).json({ success: false, message: 'Not stored just now; send it again.' });
  }
  workPushes().catch(error => console.error('[inventory-inbound] working pushes failed:', (error as Error).message));
});

export default router;
