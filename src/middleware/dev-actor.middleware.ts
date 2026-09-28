import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { Actor } from '../types/actor';
import { actorFromStaffToken } from '../services/auth';

/**
 * Who is making this request. Every till route goes through here.
 *
 *   1. A staff sign-in (Authorization: Bearer <staff token>) -- the person at the till, with the
 *      roles and permissions this database gives them. POS-CORE-002, local mode.
 *   2. Development only, and only when no sign-in was sent: a seeded dev user, so the screens can
 *      be exercised against the REAL service paths without signing in each time. It loads a real
 *      user with real roles (DEV_ACTOR=dev-cashier by default, dev-owner, dev-manager).
 *
 * IN PRODUCTION THERE IS NO SECOND BRANCH. No token, no request -- the check is here, in the
 * middleware itself, rather than left to whoever wires up the routes. REQUIRE_SIGN_IN=true turns
 * the dev fallback off locally too, which is how the sign-in screens are tested.
 *
 * The export keeps its old name so no route had to change when sign-in arrived.
 */
export const DEV_CLIENT_ID = 'dev-shop';

const DEFAULT_USER = 'dev-cashier';

export async function devActor(req: Request, res: Response, next: NextFunction) {
  try {
    const header = String(req.headers.authorization ?? '');
    if (header.toLowerCase().startsWith('bearer ')) {
      (req as any).actor = await actorFromStaffToken(header.slice(7).trim());
      return next();
    }

    if (env.NODE_ENV === 'production' || env.REQUIRE_SIGN_IN) {
      return res.status(401).json({ success: false, message: 'Please sign in.', details: { code: 'NO_STAFF' } });
    }

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
