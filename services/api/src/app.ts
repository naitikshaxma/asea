import express, { type Application } from 'express';
import cors from 'cors';
import { requestIdMiddleware } from './middlewares/requestId.js';
import { requestLogger } from './middlewares/loggerMiddleware.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { createHealthRouter } from './routes/health.js';
import { tasksRouter } from './routes/tasks.js';
import { config, type EnvConfig } from './config.js';

export function createApp(customConfig?: Partial<EnvConfig>): Application {
  const activeConfig = { ...config, ...customConfig };
  const app = express();

  // Basic middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    cors({
      origin: activeConfig.CORS_ORIGIN,
      credentials: true,
    })
  );

  // Request tracing & logging
  app.use(requestIdMiddleware);
  app.use(requestLogger);

  // Root health & readiness routes
  app.use('/', createHealthRouter(activeConfig));

  // API v1 routes
  app.use('/api/v1', tasksRouter);

  // 404 handler
  app.use(notFoundHandler);

  // Centralized error handler
  app.use(errorHandler);

  return app;
}
