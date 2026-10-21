import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env if present
dotenv.config();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // AI Service integration
  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),

  // PostgreSQL Configuration (Optional in Phase 1 dev if containers are stopped, but validated when provided)
  DATABASE_URL: z.string().optional(),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().default('autonomous_dev'),
  POSTGRES_USER: z.string().default('dev_user'),
  POSTGRES_PASSWORD: z.string().default('dev_password'),
  POSTGRES_REQUIRED_FOR_READINESS: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),

  // Redis Configuration
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_REQUIRED_FOR_READINESS: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function validateConfig(raw: Record<string, unknown> = process.env): EnvConfig {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[Config Error] Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const config = validateConfig();
