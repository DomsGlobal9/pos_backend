import crypto from 'crypto';
import { env } from '../config/env';
import { serverError } from './httpError';

/**
 * Encrypting a credential the POS must USE later (unlike a PIN, which it only ever compares).
 *
 * AES-256-GCM: the tag means a tampered or truncated value fails to decrypt instead of producing
 * garbage that is then sent to Inventory as a key. Stored as `iv.tag.ciphertext`, base64 parts.
 */

function keyBytes(): Buffer {
  const raw = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw serverError('This server is not set up to store an Inventory key. Ask ScaleEzy support.');
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return buf;
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64')).join('.');
}

export function open(sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map(p => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
