import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const logData = {
      requestId: req.id,
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs,
      userAgent: req.headers['user-agent'],
    };

    if (res.statusCode >= 500) {
      logger.error(`HTTP ${req.method} ${req.url} ${res.statusCode}`, logData);
    } else if (res.statusCode >= 400) {
      logger.warn(`HTTP ${req.method} ${req.url} ${res.statusCode}`, logData);
    } else {
      logger.info(`HTTP ${req.method} ${req.url} ${res.statusCode}`, logData);
    }
  });

  next();
}
