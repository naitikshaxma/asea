import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { validateConfig, ROOT_ENV_PATH } from '../src/config.js';

describe('Environment Configuration Validation', () => {
  it('loads .env from the monorepo root, not the workspace cwd', () => {
    expect(path.basename(ROOT_ENV_PATH)).toBe('.env');
    const rootPackageJson = JSON.parse(
      fs.readFileSync(path.join(path.dirname(ROOT_ENV_PATH), 'package.json'), 'utf-8')
    );
    expect(rootPackageJson.name).toBe('autonomous-engineer-monorepo');
  });

  it('parses valid environment configuration with defaults', () => {
    const config = validateConfig({});
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(4000);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.POSTGRES_PORT).toBe(5432);
    expect(config.REDIS_PORT).toBe(6379);
  });

  it('rejects invalid PORT configuration', () => {
    expect(() => {
      validateConfig({ PORT: 'not-a-number' });
    }).toThrow(/Invalid environment configuration/);

    expect(() => {
      validateConfig({ PORT: 999999 });
    }).toThrow(/Invalid environment configuration/);
  });

  it('rejects invalid NODE_ENV value', () => {
    expect(() => {
      validateConfig({ NODE_ENV: 'staging-unsupported' });
    }).toThrow(/Invalid environment configuration/);
  });

  it('rejects invalid AI_SERVICE_URL', () => {
    expect(() => {
      validateConfig({ AI_SERVICE_URL: 'not-a-valid-url' });
    }).toThrow(/Invalid environment configuration/);
  });
});
