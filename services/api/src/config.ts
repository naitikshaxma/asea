import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';

// Load the monorepo-root .env if present. npm workspace scripts run with
// cwd = services/api, so a cwd-relative lookup would miss it. The path is
// the same from src/ and dist/.
export const ROOT_ENV_PATH = fileURLToPath(new URL('../../../.env', import.meta.url));
dotenv.config({ path: ROOT_ENV_PATH });

const DEV_JWT_SECRET = 'dev-insecure-jwt-secret-phase2-do-not-use-in-prod-xyz';

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default('0.0.0.0'),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

    // Authentication Settings
    JWT_SECRET: z.string().default(DEV_JWT_SECRET),
    JWT_EXPIRES_IN: z.string().default('7d'),
    COOKIE_NAME: z.string().default('ae_auth_token'),
    COOKIE_SECRET: z.string().default('dev-cookie-secret-phase2'),

    // AI Service integration
    AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
    // Sent as X-Internal-Token to the agent service; VERIFICATION tasks fail without it
    INTERNAL_SERVICE_TOKEN: z.string().optional(),
    AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
    // Must not exceed the agent service's AGENT_MAX_REQUEST_BYTES
    VERIFICATION_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(5242880),

    // PostgreSQL Configuration
    DATABASE_URL: z.string().optional(),
    POSTGRES_HOST: z.string().default('localhost'),
    POSTGRES_PORT: z.coerce.number().int().default(5432),
    POSTGRES_DB: z.string().default('autonomous_dev'),
    POSTGRES_USER: z.string().default('dev_user'),
    POSTGRES_PASSWORD: z.string().default('dev_password'),
    POSTGRES_REQUIRED_FOR_READINESS: z
      .union([z.boolean(), z.string().transform((val) => val === 'true')])
      .default(false),

    // Redis Configuration
    REDIS_URL: z.string().optional(),
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().int().default(6379),
    REDIS_REQUIRED_FOR_READINESS: z
      .union([z.boolean(), z.string().transform((val) => val === 'true')])
      .default(false),

    // Repository Intelligence Engine (Phase 3)
    // Comma-separated absolute directories that repository analysis may read.
    // No default: analysis is refused until this is set explicitly.
    ALLOWED_REPO_ROOTS: z.string().optional(),
    ANALYSIS_MAX_FILES: z.coerce.number().int().positive().default(5000),
    ANALYSIS_MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(1048576), // 1MB
    ANALYSIS_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(52428800), // 50MB
    ANALYSIS_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (!data.JWT_SECRET || data.JWT_SECRET === DEV_JWT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Production deployments must provide a strong, non-default JWT_SECRET',
          path: ['JWT_SECRET'],
        });
      }
    }
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

  const data = result.data;
  // Compute default DATABASE_URL and REDIS_URL if not explicitly provided
  if (!data.DATABASE_URL) {
    data.DATABASE_URL = `postgresql://${data.POSTGRES_USER}:${data.POSTGRES_PASSWORD}@${data.POSTGRES_HOST}:${data.POSTGRES_PORT}/${data.POSTGRES_DB}`;
  }
  if (!data.REDIS_URL) {
    data.REDIS_URL = `redis://${data.REDIS_HOST}:${data.REDIS_PORT}`;
  }

  return data;
}

export const config = validateConfig();
