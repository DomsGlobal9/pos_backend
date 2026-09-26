import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { Actor } from '../types/actor';

/**
 * Gateway authentication, RS256.
 *
 * Copied deliberately from Inventory's `verifyGatewayAssertion` rather than invented: one scheme
 * across the platform means one place to fix, and the Gateway already signs for Inventory,
 * the catalog service and this. The only differences here are the audience (`pos`) and that the
 * result is an Actor rather than a user object -- see types/actor.ts for why that matters.
 *
 * The division of labour: the GATEWAY proves who someone is. THIS DATABASE decides what they may do
 * at a till. Permissions are not asked for per request, because a till must keep selling when the
 * line to the Gateway is slow, and because 150 ms is the whole latency budget.
 */

let gatewayPublicKey: string | null = null;

const getGatewayPublicKey = (): string => {
  if (gatewayPublicKey) return gatewayPublicKey;
  if (!env.GATEWAY_PUBLIC_KEY_PATH) {
    throw new Error('GATEWAY_PUBLIC_KEY_PATH is not defined in environment');
  }
  const keyPath = path.resolve(process.cwd(), env.GATEWAY_PUBLIC_KEY_PATH);
  gatewayPublicKey = fs.readFileSync(keyPath, 'utf8');
  return gatewayPublicKey;
};

export const verifyGatewayAssertion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Please sign in again.' });
    }

    const decoded = jwt.verify(authHeader.slice('Bearer '.length), getGatewayPublicKey(), {
      algorithms: ['RS256'],
      issuer: 'scal_easy_gateway',
      audience: 'pos'
    }) as jwt.JwtPayload;

    const { sub, clientId, principalType } = decoded;
    if (!sub || !clientId) {
      return res.status(401).json({ success: false, message: 'Please sign in again.' });
    }

    if (principalType === 'SUPER_ADMIN') {
      const actor: Actor = {
        kind: 'USER', clientId, id: sub, name: 'Platform admin',
        roles: ['PLATFORM_ADMIN'], permissions: []
      };
      (req as any).actor = actor;
      return next();
    }

    const user = await prisma.user.findFirst({
      where: { id: sub, clientId, status: 'ACTIVE', deletedAt: null },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
    });

    if (!user) {
      // Deliberately the same sentence as a bad token. Which of the two it was is in the log, not
      // on a screen a customer can see over the counter.
      return res.status(401).json({ success: false, message: 'Please sign in again.' });
    }

    const roles: string[] = [];
    const permissions = new Set<string>();
    for (const ur of user.roles) {
      roles.push(ur.role.name);
      for (const rp of ur.role.permissions) permissions.add(rp.permission.key);
    }

    const actor: Actor = {
      kind: 'USER',
      clientId: user.clientId,
      id: user.id,
      name: user.name,
      roles,
      permissions: [...permissions]
    };
    (req as any).actor = actor;
    next();
  } catch (error: any) {
    console.error('[auth] Gateway assertion rejected:', error.message);
    return res.status(401).json({ success: false, message: 'Please sign in again.' });
  }
};

/** The Actor a route was reached with. Routes read this; services never do. */
export const actorOf = (req: Request): Actor => {
  const actor = (req as any).actor as Actor | undefined;
  if (!actor) throw new Error('actorOf called on a route with no auth middleware in front of it');
  return actor;
};
