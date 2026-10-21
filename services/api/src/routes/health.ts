import { Router } from 'express';
import type {
  HealthResponse,
  ReadinessResponse,
  DependencyCheckResult,
} from '@autonomous-engineer/contracts';
import { config, type EnvConfig } from '../config.js';
import { checkPostgresHealth } from '../services/db.js';
import { checkRedisHealth } from '../services/redis.js';

export function createHealthRouter(appConfig: EnvConfig = config): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const response: HealthResponse = {
      status: 'ok',
      service: '@autonomous-engineer/api',
      version: '0.1.0',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      environment: appConfig.NODE_ENV,
    };

    res.status(200).json(response);
  });

  router.get('/ready', async (_req, res) => {
    const dependencies: Record<string, DependencyCheckResult> = {};

    // Check PostgreSQL
    const pgResult = await checkPostgresHealth();
    dependencies['postgres'] = pgResult;

    // Check Redis
    const redisResult = await checkRedisHealth();
    dependencies['redis'] = redisResult;

    // Evaluate readiness:
    // If postgres or redis is strictly required for readiness, failure makes readiness status 'not_ready'
    let isReady = true;

    if (appConfig.POSTGRES_REQUIRED_FOR_READINESS && pgResult.status !== 'up') {
      isReady = false;
    }

    if (appConfig.REDIS_REQUIRED_FOR_READINESS && redisResult.status !== 'up') {
      isReady = false;
    }

    const response: ReadinessResponse = {
      status: isReady ? 'ready' : 'not_ready',
      service: '@autonomous-engineer/api',
      timestamp: new Date().toISOString(),
      dependencies,
    };

    const statusCode = isReady ? 200 : 503;
    res.status(statusCode).json(response);
  });

  return router;
}

export const healthRouter = createHealthRouter(config);
