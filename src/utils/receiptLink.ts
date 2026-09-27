import crypto from 'crypto';
import { env } from '../config/env';

/**
 * The digital receipt's address. POS-RCPT-009.
 *
 * Here rather than in services/receipts so the sale can give every new bill its token without the
 * two services importing each other.
 */

/** 24 random URL-safe characters -- unguessable, and short enough for a QR code on 80 mm paper. */
export const newReceiptToken = () => crypto.randomBytes(18).toString('base64url');

/** The till's own address unless the deployment names a public one. */
export function receiptUrl(token: string) {
  const base = (process.env.PUBLIC_RECEIPT_BASE_URL || env.FRONTEND_URL.split(',')[0]).trim().replace(/\/+$/, '');
  return `${base}/r/${token}`;
}
