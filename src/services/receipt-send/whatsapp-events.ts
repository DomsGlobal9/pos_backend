import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { forgetAccounts } from './receipt-send.service';

/**
 * THE WHATSAPP SERVICE TELLING US (12 Oct, the service's preferred way): a bill sent, delivered, read
 * or failed, and the shop's number connected or dropped. Polling GET /v1/messages/:id stays as the
 * fallback for a till without the secret.
 *
 *   - Signed: HMAC-SHA256 of the raw body with WHATSAPP_WEBHOOK_SECRET, compared in constant time
 *   - At least once: each event id is remembered for 7 days and a repeat does nothing
 *   - Ticks arrive out of order: a status only ever moves forward (QUEUED < SENDING < SENT <
 *     DELIVERED < READ); FAILED/EXPIRED are final, except that a later delivered/read tick proves it
 *     arrived after all
 *
 * Returns the HTTP status to answer with.
 */
const RANK: Record<string, number> = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4 };
const FINAL = new Set(['FAILED', 'EXPIRED']);

export function nextStatus(current: string, incoming: string): string | null {
  if (incoming === current) return null;
  if (FINAL.has(incoming)) return FINAL.has(current) || (RANK[current] ?? -1) >= RANK.DELIVERED ? null : incoming;
  if (!(incoming in RANK)) return null;
  if (FINAL.has(current)) return RANK[incoming] >= RANK.DELIVERED ? incoming : null;
  return RANK[incoming] > (RANK[current] ?? -1) ? incoming : null;
}

export async function handleWhatsAppEvent(raw: Buffer, signature: string | undefined): Promise<number> {
  const secret = (process.env.WHATSAPP_WEBHOOK_SECRET ?? '').trim();
  if (!secret) return 503;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const got = String(signature ?? '');
  if (expected.length !== got.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return 401;

  let event: any;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return 400; }
  if (!event?.id || typeof event.id !== 'string') return 400;

  const fresh = await prisma.whatsappEventSeen.createMany({ data: [{ id: event.id }], skipDuplicates: true });
  if (fresh.count === 0) return 204;

  const data = event.data ?? {};
  if (event.type === 'message.status' && data.messageId) {
    const incoming = String(data.status ?? '').toUpperCase();
    const row = await prisma.receiptSend.findFirst({ where: { providerId: String(data.messageId) }, select: { id: true, status: true } });
    const next = row ? nextStatus(row.status, incoming) : null;
    if (row && next) {
      await prisma.receiptSend.update({
        where: { id: row.id },
        // A delivered or read tick clears an earlier failure: it proves the bill arrived.
        data: { status: next, failReason: FINAL.has(next) ? (data.failReason ?? null) : null }
      });
    }
  } else if (String(event.type ?? '').startsWith('account.')) {
    forgetAccounts();
  }

  // Housekeeping: the service never repeats an event after a few minutes; a week is plenty.
  await prisma.whatsappEventSeen.deleteMany({ where: { seenAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } });
  return 204;
}
