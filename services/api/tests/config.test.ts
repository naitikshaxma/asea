import { describe, it, expect } from 'vitest';
import { validateConfig } from '../src/config.js';

describe('Environment Configuration Validation', () => {
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
