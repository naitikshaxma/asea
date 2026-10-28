import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { authStateStore, type RateWindowResult } from '../services/authStateStore.js';
import { AppError } from './errorHandler.js';

interface RateLimiterOptions {
  windowMs: number;
  max: number;
  now?: () => number;
  keyGenerator?: (req: Request) => string;
  increment?: (key: string, windowMs: number) => Promise<RateWindowResult>;
}

/**
 * Fixed-window rate limiter. Production and normal development use the shared
 * Redis store; only tests or an explicit development override use memory.
 */
export function createRateLimiter({
  windowMs,
  max,
  now = Date.now,
  keyGenerator = (req) => req.ip || req.socket.remoteAddress || 'unknown',
  increment,
}: RateLimiterOptions) {
  const localBuckets = new Map<string, { count: number; resetAt: number }>();

  const consume = increment ?? (async (key: string, durationMs: number): Promise<RateWindowResult> => {
    const currentTime = now();
    let bucket = localBuckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      if (localBuckets.size >= 10_000) {
        for (const [candidate, value] of localBuckets) {
          if (value.resetAt <= currentTime) localBuckets.delete(candidate);
        }
        if (localBuckets.size >= 10_000) {
          const oldest = localBuckets.keys().next().value;
          if (oldest) localBuckets.delete(oldest);
        }
      }
      bucket = { count: 0, resetAt: currentTime + durationMs };
      localBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return { count: bucket.count, resetAfterMs: Math.max(0, bucket.resetAt - currentTime) };
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.baseUrl}${req.path}:${keyGenerator(req)}`;
    void consume(key, windowMs).then(({ count, resetAfterMs }) => {
      const remaining = Math.max(0, max - count);
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil((now() + resetAfterMs) / 1000)));

      if (count > max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(resetAfterMs / 1000))));
        return next(new AppError(429, 'RATE_LIMITED', 'Too many authentication attempts. Try again later.'));
      }
      next();
    }).catch(() => {
      // Authentication must not become unlimited during a Redis outage.
      next(new AppError(503, 'SERVICE_UNAVAILABLE', 'Authentication protection is temporarily unavailable'));
    });
  };
}

export const authRateLimit = createRateLimiter({
  windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
  increment: (key, durationMs) => authStateStore.incrementRateLimit(key, durationMs),
});
