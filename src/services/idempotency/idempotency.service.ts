import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, isHttpError } from '../../utils/httpError';

/**
 * Idempotency-Key for the public API. POS-API-004, -005, POS-CORE-009.
 *
 * The same idea as the till's once-key (CONTRACTS §1.4), for software that calls us over a network
 * that drops replies: send a key with a write, and sending it again gets the FIRST answer back
 * instead of doing the work twice.
 *
 *   same key, same request       the first answer, word for word (header Idempotent-Replayed: true)
 *   same key, different request  refused -- a bug on their side, and guessing which one was meant
 *                                is how prices get set wrongly
 *   same key, first still running  "still working on it, send again in a moment" (409)
 *
 * The key is claimed with one INSERT before any work, so two copies arriving together cannot both
 * run. Answers the caller should retry (a 5xx, anything unexpected) are NOT kept: the claim is let go
 * and the next attempt does the work. Refusals (4xx) are kept -- the same request will be refused
 * the same way, and saying so consistently is the point.
 *
 * Kept 24 hours, which is longer than any sane retry loop.
 */

const KEEP_MS = 24 * 3_600_000;

export interface OnceResult<T> { status: number; body: T; replayed: boolean }

export function requestHash(method: string, path: string, body: unknown) {
  return crypto.createHash('sha256').update(`${method} ${path}\n${JSON.stringify(body ?? null)}`).digest('hex');
}

export async function once<T>(
  clientId: string,
  key: string | undefined,
  hash: string,
  run: () => Promise<{ status: number; body: T }>
): Promise<OnceResult<T>> {
  if (key === undefined) {
    const r = await run();
    return { ...r, replayed: false };
  }
  const k = key.trim();
  if (k.length < 8 || k.length > 200) throw badRequest('Idempotency-Key must be 8 to 200 characters -- a UUID is ideal.');

  // Old claims are cleared as we go; a table nobody reads should not grow forever.
  await prisma.apiRequestOnce.deleteMany({ where: { clientId, createdAt: { lt: new Date(Date.now() - KEEP_MS) } } });

  const claimed = await prisma.$executeRaw`
    INSERT INTO api_request_once (id, client_id, idempotency_key, request_hash, status, created_at)
    VALUES (${crypto.randomUUID()}, ${clientId}, ${k}, ${hash}, 0, now() AT TIME ZONE 'UTC')
    ON CONFLICT (client_id, idempotency_key) DO NOTHING`;

  if (claimed === 0) {
    const first = await prisma.apiRequestOnce.findUnique({ where: { clientId_idempotencyKey: { clientId, idempotencyKey: k } } });
    if (!first) throw conflict('That request is still being worked on. Send it again in a moment.', { code: 'IN_PROGRESS' });
    if (first.requestHash !== hash) {
      throw conflict('This Idempotency-Key was already used for a different request. Use a new key for a new request.', { code: 'KEY_REUSED' });
    }
    if (first.status === 0) throw conflict('That request is still being worked on. Send it again in a moment.', { code: 'IN_PROGRESS' });
    return { status: first.status, body: first.response as T, replayed: true };
  }

  try {
    const r = await run();
    await prisma.apiRequestOnce.update({
      where: { clientId_idempotencyKey: { clientId, idempotencyKey: k } },
      data: { status: r.status, response: r.body as unknown as Prisma.InputJsonValue }
    });
    return { ...r, replayed: false };
  } catch (error) {
    if (isHttpError(error) && error.statusCode < 500) {
      const body = { success: false, message: error.message, ...(error.details ? { details: error.details } : {}) };
      await prisma.apiRequestOnce.update({
        where: { clientId_idempotencyKey: { clientId, idempotencyKey: k } },
        data: { status: error.statusCode, response: body as unknown as Prisma.InputJsonValue }
      });
    } else {
      await prisma.apiRequestOnce.deleteMany({ where: { clientId, idempotencyKey: k } });
    }
    throw error;
  }
}
