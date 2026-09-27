import crypto from 'crypto';

/**
 * Webhook signatures. POS-WEB-005, CONTRACTS "Webhook delivery rules".
 *
 * HMAC-SHA256 over `timestamp + "." + rawBody`, sent as
 *
 *     X-ScaleEzy-Timestamp: 1790512345
 *     X-ScaleEzy-Signature: v1=5f2c...
 *
 * The timestamp is INSIDE the signed material. Without it a signature is "a bearer token wearing a
 * signature's name": a captured request replays forever. A receiver checks the signature over the
 * raw body exactly as received (not re-serialised JSON) and refuses a timestamp more than five
 * minutes old.
 */

export const SIGNATURE_TOLERANCE_S = 300;

export function sign(secret: string, timestamp: number, rawBody: string): string {
  return 'v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** What a receiver does. Here so the tests -- and anyone reading -- check against the same code. */
export function verify(secret: string, timestampHeader: string | undefined, signatureHeader: string | undefined, rawBody: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(timestampHeader);
  if (!Number.isInteger(ts) || Math.abs(nowS - ts) > SIGNATURE_TOLERANCE_S || !signatureHeader) return false;
  const expected = Buffer.from(sign(secret, ts, rawBody));
  const given = Buffer.from(signatureHeader);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
