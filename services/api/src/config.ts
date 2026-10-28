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
    AUTH_STATE_STORE: z.enum(['redis', 'memory']).optional(),
    AUTH_STATE_KEY_PREFIX: z.string().regex(/^[a-zA-Z0-9:_-]{1,64}$/).default('asea'),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    // Secure flag on the session cookie; defaults to true only in production.
    // Set false when serving production builds over plain HTTP (local stack).
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),
    // Development-only email sink. When configured, security links are held
    // in process memory and exposed only from the protected dev mailbox route.
    DEV_MAILBOX_TOKEN: z.string().min(24).optional(),

    // AI Service integration
    AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
    // Sent as X-Internal-Token to the agent service; VERIFICATION tasks fail without it
    INTERNAL_SERVICE_TOKEN: z.string().optional(),
    AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
    // Must not exceed the agent service's AGENT_MAX_REQUEST_BYTES
    VERIFICATION_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(5242880),
    // Repository index sent to the engine for the architecture agent (Python files at the base commit)
    INDEX_MAX_FILES: z.coerce.number().int().positive().default(5000),
    INDEX_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
    // Per index request; must not exceed the agent service's AGENT_MAX_REQUEST_BYTES
    INDEX_BATCH_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),

    // GitHub: token used to post verification results as pull request comments
    // (a token with "issues: write"/"pull requests: write"); none = comments skipped
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_API_URL: z.string().url().default('https://api.github.com'),
    // GitHub App credentials stay server-side. The PEM may use literal `\\n`
    // sequences in container environment variables; the client normalizes it.
    GITHUB_APP_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().trim().regex(/^\d+$/).optional()),
    GITHUB_APP_SLUG: z.preprocess((value) => value === '' ? undefined : value, z.string().trim().regex(/^[a-zA-Z0-9-]+$/).optional()),
    GITHUB_APP_CLIENT_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().trim().min(1).optional()),
    GITHUB_APP_CLIENT_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().optional()),
    GITHUB_APP_PRIVATE_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().optional()),
    GITHUB_APP_WEBHOOK_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().optional()),
    // Public URL of the web app, for links in PR comments and the webhook URL shown in the UI
    PUBLIC_WEB_URL: z.string().url().default('http://localhost:8080'),

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
    // Separate writable root for disposable CODE_PATCH task snapshots.
    TASK_WORKSPACE_ROOT: z.string().optional(),
    // The worker stays fail-closed unless an operator explicitly enables the
    // Docker CLI provider and supplies an already-built, locally available image.
    SANDBOX_PROVIDER: z.enum(['unavailable', 'docker']).default('unavailable'),
    SANDBOX_DOCKER_IMAGE: z.string().trim().min(1).optional(),
    SANDBOX_DOCKER_EXECUTABLE: z.string().trim().min(1).default('docker'),
    SANDBOX_DOCKER_UID: z.coerce.number().int().min(1).max(65535).default(process.getuid?.() || 1000),
    SANDBOX_DOCKER_GID: z.coerce.number().int().min(1).max(65535).default(process.getgid?.() || 1000),
    SANDBOX_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(180000),
    SANDBOX_MEMORY_MB: z.coerce.number().int().min(128).max(4096).default(1024),
    SANDBOX_CPU_COUNT: z.coerce.number().int().min(1).max(4).default(2),
    SANDBOX_MAX_PROCESSES: z.coerce.number().int().min(16).max(256).default(128),
    SANDBOX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(2097152).default(262144),
    // Writable test files live only in a bounded per-container tmpfs, not the host bind mount.
    SANDBOX_WORKSPACE_SIZE_MB: z.coerce.number().int().min(64).max(1024).default(256),
    ANALYSIS_MAX_FILES: z.coerce.number().int().positive().default(5000),
    ANALYSIS_MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(1048576), // 1MB
    ANALYSIS_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(52428800), // 50MB
    ANALYSIS_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  })
  .superRefine((data, ctx) => {
    const githubAppConfig = [data.GITHUB_APP_ID, data.GITHUB_APP_SLUG, data.GITHUB_APP_CLIENT_ID, data.GITHUB_APP_CLIENT_SECRET, data.GITHUB_APP_PRIVATE_KEY, data.GITHUB_APP_WEBHOOK_SECRET];
    if (githubAppConfig.some(Boolean) && !githubAppConfig.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET must be configured together',
        path: ['GITHUB_APP_ID'],
      });
    }
    if (data.NODE_ENV === 'production' && data.AUTH_STATE_STORE === 'memory') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Production deployments must use Redis for authentication state',
        path: ['AUTH_STATE_STORE'],
      });
    }
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
  // Tests may use a process-local state store. All normal deployments use
  // Redis, and production explicitly rejects the development-only fallback.
  data.AUTH_STATE_STORE ??= data.NODE_ENV === 'test' ? 'memory' : 'redis';
  if (data.AUTH_STATE_STORE === 'redis') data.REDIS_REQUIRED_FOR_READINESS = true;

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
