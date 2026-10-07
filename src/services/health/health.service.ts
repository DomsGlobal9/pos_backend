import { prisma } from '../../lib/prisma';
import { env, hasInventory } from '../../config/env';

/**
 * Is this service actually able to take a sale?
 *
 * Deliberately more than a 200. A load balancer's health check that only proves the process is
 * running will happily keep a till pointed at a server whose database is unreachable, and the shop
 * finds out at the counter. So this asks the database a real question.
 *
 * It takes no Actor, unlike every other service function here, and that is the one exception to the
 * rule in types/actor.ts: nothing it returns belongs to a tenant. Anything tenant-scoped must take
 * an Actor -- see that file for why.
 */

export interface Health {
  ok: boolean;
  service: 'pos';
  /** 'standalone' -- its own item and customer lists. 'with-inventory' -- Inventory is master. */
  mode: 'standalone' | 'with-inventory';
  database: 'up' | 'down';
  /** Milliseconds for the database round trip. A till is judged on latency, so it is measured from
   * the first day rather than added when someone complains. */
  databaseMs: number | null;
  authMode: 'local' | 'gateway';
  /** Which commit is running (Render sets RENDER_GIT_COMMIT): "did my push deploy?" in one look. */
  commit: string | null;
  at: string;
}

export async function health(): Promise<Health> {
  const startedAt = Date.now();
  let database: 'up' | 'down' = 'down';
  let databaseMs: number | null = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
    database = 'up';
    databaseMs = Date.now() - startedAt;
  } catch (error: any) {
    // Logged, not returned. Which host or credential failed is not something to publish on an
    // unauthenticated endpoint.
    console.error('[health] database unreachable:', error.message);
  }

  return {
    ok: database === 'up',
    service: 'pos',
    mode: hasInventory() ? 'with-inventory' : 'standalone',
    database,
    databaseMs,
    authMode: env.AUTH_MODE,
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
    at: new Date().toISOString()
  };
}
