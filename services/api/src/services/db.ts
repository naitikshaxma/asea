import pg from 'pg';
import type { DependencyCheckResult } from '@autonomous-engineer/contracts';
import { config } from '../config.js';
import { logger } from '../logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getDbPool(): pg.Pool {
  if (!pool) {
    if (config.DATABASE_URL) {
      pool = new Pool({
        connectionString: config.DATABASE_URL,
        connectionTimeoutMillis: 2000,
      });
    } else {
      pool = new Pool({
        host: config.POSTGRES_HOST,
        port: config.POSTGRES_PORT,
        database: config.POSTGRES_DB,
        user: config.POSTGRES_USER,
        password: config.POSTGRES_PASSWORD,
        connectionTimeoutMillis: 2000,
      });
    }
    pool.on('error', (err) => {
      logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
    });
  }
  return pool;
}

export async function checkPostgresHealth(): Promise<DependencyCheckResult> {
  const start = Date.now();
  try {
    const p = getDbPool();
    const client = await p.connect();
    try {
      await client.query('SELECT 1');
      const latencyMs = Date.now() - start;
      return {
        status: 'up',
        latencyMs,
        message: 'PostgreSQL connection successful',
      };
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      status: 'down',
      latencyMs,
      message: 'PostgreSQL connection failed',
      error: errorMessage,
    };
  }
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
