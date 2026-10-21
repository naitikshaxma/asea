import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { closeDbPool } from './services/db.js';

const app = createApp();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(`Autonomous Engineer API started`, {
    host: config.HOST,
    port: config.PORT,
    environment: config.NODE_ENV,
    healthEndpoint: `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}/health`,
    readinessEndpoint: `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}/ready`,
  });
});

// Graceful shutdown handling
function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Gracefully shutting down HTTP server...`);
  server.close(async () => {
    logger.info('HTTP server closed.');
    try {
      await closeDbPool();
      logger.info('Database pool closed.');
    } catch (err) {
      logger.error('Error closing database pool during shutdown', { error: String(err) });
    }
    process.exit(0);
  });

  // Force shutdown after 10s if connections don't drain
  setTimeout(() => {
    logger.error('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
