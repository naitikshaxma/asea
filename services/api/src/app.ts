import express, { type Application } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { requestIdMiddleware } from './middlewares/requestId.js';
import { requestLogger } from './middlewares/loggerMiddleware.js';
import { authenticate } from './middlewares/authMiddleware.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { createHealthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { workspacesRouter } from './routes/workspaces.js';
import { repositoriesRouter } from './routes/repositories.js';
import { intelligenceRouter } from './routes/intelligence.js';
import { tasksRouter } from './routes/tasks.js';
import { verificationRouter } from './routes/verification.js';
import { policiesRouter } from './routes/policies.js';
import { webhooksRouter, type RawBodyRequest } from './routes/webhooks.js';
import { config, type EnvConfig } from './config.js';

export function createApp(customConfig?: Partial<EnvConfig>): Application {
  const activeConfig = { ...config, ...customConfig };
  const app = express();

  // Basic middleware. Webhook signatures are computed over the exact request
  // bytes, so those are kept for webhook paths (routes/webhooks.ts).
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        if (req.url?.startsWith('/api/v1/webhooks/')) (req as RawBodyRequest).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser(activeConfig.COOKIE_SECRET));
  app.use(
    cors({
      origin: activeConfig.CORS_ORIGIN,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Api-Version'],
    })
  );

  // Request tracing & logging
  app.use(requestIdMiddleware);
  app.use(requestLogger);

  // Authentication token resolution (populates req.user if token present)
  app.use(authenticate);

  // Root health & readiness routes
  app.use('/', createHealthRouter(activeConfig));

  // API v1 routes
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1', workspacesRouter);
  app.use('/api/v1', repositoriesRouter);
  app.use('/api/v1', intelligenceRouter);
  app.use('/api/v1', tasksRouter);
  app.use('/api/v1', verificationRouter);
  app.use('/api/v1', policiesRouter);
  app.use('/api/v1', webhooksRouter);

  // 404 handler
  app.use(notFoundHandler);

  // Centralized error handler
  app.use(errorHandler);

  return app;
}
