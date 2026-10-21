import { Redis } from 'ioredis';
import type { DependencyCheckResult } from '@autonomous-engineer/contracts';
import { config } from '../config.js';

export async function checkRedisHealth(): Promise<DependencyCheckResult> {
  const start = Date.now();
  let client: Redis | null = null;
  try {
    const redisOptions = {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // Do not retry on failure
      lazyConnect: true,
    };

    if (config.REDIS_URL) {
      client = new Redis(config.REDIS_URL, redisOptions);
    } else {
      client = new Redis({
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        ...redisOptions,
      });
    }

    await client.connect();
    const pingResult = await client.ping();
    const latencyMs = Date.now() - start;

    if (pingResult === 'PONG') {
      return {
        status: 'up',
        latencyMs,
        message: 'Redis connection successful',
      };
    }

    return {
      status: 'degraded',
      latencyMs,
      message: `Unexpected Redis ping response: ${pingResult}`,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      status: 'down',
      latencyMs,
      message: 'Redis connection failed',
      error: errorMessage,
    };
  } finally {
    if (client) {
      try {
        client.disconnect();
      } catch {
        // ignore disconnect error
      }
    }
  }
}
