import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { Actor, PERMISSIONS } from '../types/actor';

/**
 * A development stand-in for sign-in, which is step 4's work.
 *
 * It exists so the sell screen can be built and tested against the REAL sale path -- the real
 * transaction, the real invoice series, the real unique constraints -- rather than against a mock
 * of it. The thing being built is never stubbed; only the identity in front of it is, and only
 * until there is a sign-in to replace it.
 *
 * IT REFUSES TO RUN IN PRODUCTION. That check is here, in the middleware itself, rather than left
 * to whoever wires up the routes: a development-only auth bypass that depends on being mounted
 * correctly is one careless import away from being a way into every shop's till. Here, it cannot
 * be mounted wrongly, because it checks for itself.
 */
export const DEV_CLIENT_ID = 'dev-shop';

export function devActor(req: Request, res: Response, next: NextFunction) {
  if (env.NODE_ENV === 'production') {
    console.error('[auth] devActor reached in production. Refusing the request.');
    return res.status(500).json({
      success: false,
      message: 'This till is not configured for signing in yet. Contact support.'
    });
  }

  const actor: Actor = {
    kind: 'USER',
    clientId: DEV_CLIENT_ID,
    id: 'dev-cashier',
    name: 'Dev cashier',
    roles: ['OWNER'],
    permissions: Object.values(PERMISSIONS)
  };
  (req as any).actor = actor;
  next();
}
