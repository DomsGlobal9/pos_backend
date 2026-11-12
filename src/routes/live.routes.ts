import { Router } from 'express';
import { devActor } from '../middleware/dev-actor.middleware';
import { listen } from '../services/live';

const router = Router();
router.use(devActor);

/**
 * GET /api/v1/live -- a stream of "this changed" for the signed-in person's shop (server-sent events).
 *
 * Each message is `data: {"topics":["sales",...]}`; the screen refetches what it shows. Nothing about
 * the change itself is in it -- the screen asks the usual routes, with the usual permissions. A
 * comment line every 20 s keeps proxies (Render's) from closing a quiet line.
 */
router.get('/', (req, res) => {
  const clientId = (req as any).actor.clientId as string;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(': open\n\n');
  const stop = listen(clientId, topics => res.write(`data: ${JSON.stringify({ topics })}\n\n`));
  const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => { clearInterval(beat); stop(); });
});

export default router;
