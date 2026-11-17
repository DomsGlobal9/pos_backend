import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { unauthorized } from '../../utils/httpError';
import { Actor } from '../../types/actor';

/**
 * WHO MADE AN OFFLINE SALE, WITHOUT THEIR SIGN-IN STAYING ON THE DEVICE (17 Nov, audit pos-run-1 #4).
 *
 * A sale made with the internet off is sent later, and must still carry the name of the person who
 * made it -- the bill, the shift and the cash count all hang on that name. The till used to keep the
 * maker's whole 12-hour sign-in beside the sale for that. After Switch it was still there, in the
 * browser's storage, for the next person to lift and use as their own: a cashier after a manager.
 * Dropping it at Switch (tried the same morning) put the sale on the NEXT person's name, which is
 * worse.
 *
 * So the maker leaves a STAMP on the sale instead of their sign-in:
 *
 *   - At sign-in the server gives the person a second secret, the offline key, made from their
 *     sign-in's own signature. The till holds it only while they are signed in.
 *   - Queuing a sale, the till writes down the sign-in's first two parts (who, which shop, until
 *     when -- NOT the signature, so it cannot be used to sign in) and a proof: an HMAC, under the
 *     offline key, of that sale's once-key and the exact bytes of its body.
 *   - When the sale arrives, the server rebuilds the signature from those two parts (only it can),
 *     derives the same offline key, and checks the proof against the bytes it received.
 *
 * What is left on the device can do one thing: send that one sale, unchanged, as its maker -- which
 * is exactly what it is for, and sending it twice makes one bill (the once-key). It cannot sign in,
 * approve, refund, or put the maker's name on anything else.
 */
const b64url = (b: Buffer) => b.toString('base64url');
const signatureOf = (headerAndPayload: string) => b64url(crypto.createHmac('sha256', env.JWT_SECRET).update(headerAndPayload).digest());

/** The offline key that goes with a staff sign-in. Given out with it, at Open and at Switch. */
export function offlineKeyFor(staffToken: string): string {
  const signature = staffToken.split('.')[2] ?? '';
  return b64url(crypto.createHmac('sha256', env.JWT_SECRET).update(`offline-sale:${signature}`).digest());
}

const refused = (why: string) => unauthorized('This sale could not be matched to the person who made it.', { code: 'MAKER_STAMP_REFUSED', why });

export type MakerStamp = { claims: string; proof: string; onceKey: unknown; madeOfflineAt: unknown; rawBody: Buffer | undefined };

/**
 * Whose sale this is, proved by its stamp: the shop and the person, or a refusal. The caller still
 * has to check that the sender is an open till of the same shop, and that the person still works there.
 */
export function readMakerStamp(s: MakerStamp): { clientId: string; userId: string } {
  if (typeof s.claims !== 'string' || !/^[\w-]{10,400}\.[\w-]{10,800}$/.test(s.claims)) throw refused('shape');
  if (typeof s.proof !== 'string' || !/^[0-9a-f]{64}$/.test(s.proof)) throw refused('shape');
  if (typeof s.onceKey !== 'string' || !s.rawBody?.length) throw refused('nothing to check');

  // Only the server can finish the sign-in the two parts came from; with it, what that sign-in said.
  const signature = signatureOf(s.claims);
  let c: jwt.JwtPayload;
  try {
    c = jwt.verify(`${s.claims}.${signature}`, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'scaleezy-pos', ignoreExpiration: true }) as jwt.JwtPayload;
  } catch { throw refused('not a sign-in'); }
  if (c.typ !== 'staff' || typeof c.cid !== 'string' || typeof c.sub !== 'string' || typeof c.exp !== 'number') throw refused('not a staff sign-in');

  const key = offlineKeyFor(`${s.claims}.${signature}`);
  const bodyHash = crypto.createHash('sha256').update(s.rawBody).digest('hex');
  const expected = crypto.createHmac('sha256', key).update(`${s.onceKey}\n${bodyHash}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s.proof))) throw refused('proof');

  // The sale was made while that sign-in was good. The time is the till's own clock, but it is inside
  // the body the proof covers, so only the maker's own session could have written it.
  const made = typeof s.madeOfflineAt === 'string' ? Date.parse(s.madeOfflineAt) : NaN;
  if (Number.isNaN(made)) throw refused('not an offline sale');
  const slack = 5 * 60_000;
  if (made > c.exp * 1000 + slack || (typeof c.iat === 'number' && made < c.iat * 1000 - slack)) throw refused('made outside the sign-in');

  return { clientId: c.cid, userId: c.sub };
}

/** For the tests and the route: is this person's Actor the stamp's maker? */
export const stampedFor = (actor: Actor, stamp: { clientId: string; userId: string }) => actor.clientId === stamp.clientId && actor.id === stamp.userId;
