import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { openTill, staffOnTill, switchTo, closeTill, closeAllTills, actorFromStaffToken } from '../services/auth';
import { devActor } from '../middleware/dev-actor.middleware';

/**
 * Signing in at the till. POS-CORE-002.
 *
 *   POST /auth/open     { login, password, shopId?, deviceId? }   -> till + staff token
 *   GET  /auth/staff    x-till-token                               -> names for "Who's at the till?"
 *   POST /auth/switch   x-till-token, { userId, pin }              -> staff token
 *   GET  /auth/me       Authorization (or the dev user)            -> who is billing
 *   POST /auth/close    x-till-token                               -> the till on this device, closed
 *   POST /auth/close-all  (owner/manager)                          -> every till of the shop, closed
 */
const router = Router();

// Sign-in is where guessing happens. Tight per address; the per-login lockout is in the service.
router.use(['/open', '/switch'], rateLimit({
  windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message: 'Too many tries from this device. Wait a minute and try again.' }
}));

const till = (req: any) => req.headers['x-till-token'] as string | undefined;

router.post('/open', async (req, res, next) => {
  try { res.json({ success: true, data: await openTill(req.body ?? {}) }); } catch (e) { next(e); }
});
router.get('/staff', async (req, res, next) => {
  try { res.json({ success: true, data: await staffOnTill(till(req)) }); } catch (e) { next(e); }
});
router.post('/switch', async (req, res, next) => {
  try { res.json({ success: true, data: await switchTo(till(req), req.body ?? {}) }); } catch (e) { next(e); }
});
router.get('/me', devActor, (req: any, res) => {
  const a = req.actor;
  res.json({ success: true, data: { id: a.id, name: a.name, roles: a.roles, clientId: a.clientId } });
});
router.post('/close', async (req: any, res, next) => {
  /*
   * WHO CLOSED IT, where there is a who.
   *
   * This route cannot require a signed-in person the way /close-all does: the till has to close
   * when the staff turn has already expired, which is exactly when a device gets handed back at the
   * end of a shift. Requiring an actor would lock the device shut.
   *
   * So the person is resolved if their token is still good, and the close happens either way -- but
   * when it was somebody pressing the button, the log says who, and so does the next device to wake
   * up and find itself signed out. Passing a flat null here is why Activity showed six "Till
   * opened" in an afternoon and not one close (6 Oct), and why the audit line added for it could
   * never be written.
   */
  const raw = String(req.headers.authorization ?? '').replace(/^Bearer /, '').trim();
  const by = raw ? await actorFromStaffToken(raw).catch(() => null) : null;
  try { res.json({ success: true, data: await closeTill(till(req), by) }); } catch (e) { next(e); }
});
router.post('/close-all', devActor, async (req: any, res, next) => {
  try { res.json({ success: true, data: await closeAllTills(req.actor) }); } catch (e) { next(e); }
});

export default router;
