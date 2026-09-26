import { PrismaClient } from '@prisma/client';

/**
 * One client for the process.
 *
 * ts-node-dev respawns on every save, and a fresh PrismaClient per respawn leaks connections until
 * the database refuses new ones -- which in dev looks like the till mysteriously failing after
 * twenty minutes of editing. Kept on `global` so a reload reuses it.
 */
const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
