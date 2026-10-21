import { PrismaClient } from '@prisma/client';
import { config } from '../config.js';
import { logger } from '../logger.js';

let prismaInstance: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      datasources: {
        db: {
          url: config.DATABASE_URL,
        },
      },
      log:
        config.LOG_LEVEL === 'debug'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'event', level: 'error' },
              { emit: 'event', level: 'warn' },
            ]
          : [{ emit: 'event', level: 'error' }],
    });

    if (config.LOG_LEVEL === 'debug') {
      // @ts-expect-error Prisma event typing
      prismaInstance.$on('query', (e: { query: string; duration: number }) => {
        logger.debug('Prisma Query', { query: e.query, durationMs: e.duration });
      });
    }

    // @ts-expect-error Prisma event typing
    prismaInstance.$on('error', (e: { message: string }) => {
      logger.error('Prisma Error', { error: e.message });
    });
  }

  return prismaInstance;
}

export const prisma = getPrismaClient();

export async function disconnectPrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
}
