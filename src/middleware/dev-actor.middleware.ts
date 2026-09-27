import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';

/**
 * A development stand-in for sign-in, which is not built yet.
 *
 * It exists so the screens can be exercised against the REAL service paths -- the real
 * transaction, the real invoice series, the real permission checks -- rather than against mocks.
 * The thing being built is never stubbed; only the question "who is signed in" is.
 *
 * IT LOADS A REAL USER, WITH REAL ROLES. The first version handed every request a hardcoded OWNER
 * holding every permission, which meant no screen could ever show an approval prompt: an owner
 * never needs one. From Phase 4 it reads a seeded user from the database, so the browser sees
 * exactly what that person would see.
 *
 *     DEV_ACTOR=dev-cashier   (default) -- has to ask for anything over the limit
 *     DEV_ACTOR=dev-owner               -- can do everything
 *
 * IT REFUSES TO RUN IN PRODUCTION. That check is here, in the middleware itself, rather than left
 * to whoever wires up the routes: a development-only auth bypass that depends on being mounted
 * correctly is one careless import away from being a way into every shop's till.
 */
export const DEV_CLIENT_ID = 'dev-shop';

const DEFAULT_USER = 'dev-cashier';

export async function devActor(req: Request, res: Response, next: NextFunction) {
  if (env.NODE_ENV === 'production') {
    console.error('[auth] devActor reached in production. Refusing the request.');
    return res.status(500).json({
      success: false,
      message: 'This till is not configured for signing in yet. Contact support.'
    });
  }

  try {
    const userId = process.env.DEV_ACTOR || DEFAULT_USER;
    const user = await prisma.user.findFirst({
      where: { id: userId, clientId: DEV_CLIENT_ID, status: 'ACTIVE', deletedAt: null },
      select: {
        id: true, name: true,
        roles: { select: { role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } } } }
      }
    });

    if (!user) {
      return res.status(500).json({
        success: false,
        message: 'The development user is missing. Run the seed script once, then try again.'
      });
    }

    const actor: Actor = {
      kind: 'USER',
      clientId: DEV_CLIENT_ID,
      id: user.id,
      name: user.name,
      roles: user.roles.map(r => r.role.name),
      permissions: [...new Set(user.roles.flatMap(r => r.role.permissions.map(p => p.permission.key)))]
    };
    (req as any).actor = actor;
    next();
  } catch (error) {
    next(error);
  }
}
