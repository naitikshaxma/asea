import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactOutputPair, redactSensitiveData, redactSensitiveText } from '../../src/services/engineering/outputRedaction.js';

const SYNTHETIC_SECRET = 'ASEA_SYNTHETIC_HOST_SECRET_7b9a1c3d';

afterEach(() => vi.unstubAllEnvs());

describe('sandbox evidence redaction', () => {
  it('redacts configured environment values and common credential formats without returning them', () => {
    vi.stubEnv('ASEA_TEST_SECRET', SYNTHETIC_SECRET);
    const unsafe = [
      `stdout: ${SYNTHETIC_SECRET}`,
      'stderr: API_TOKEN=fixture-only-token-123456',
      'authorization: Bearer fixture-bearer-token-123456',
      'report: {"password": "fixture value containing spaces", "authorization": "Bearer fixture-json-token-123456"}',
      'private key: -----BEGIN PRIVATE KEY-----\nfixture-private-key-material\n-----END PRIVATE KEY-----',
      'github_pat_fixtureOnlyToken0123456789',
    ].join('\n');

    const safe = redactSensitiveText(unsafe);
    expect(safe).not.toContain(SYNTHETIC_SECRET);
    expect(safe).not.toContain('fixture-only-token-123456');
    expect(safe).not.toContain('fixture-bearer-token-123456');
    expect(safe).not.toContain('fixture value containing spaces');
    expect(safe).not.toContain('fixture-json-token-123456');
    expect(safe).not.toContain('fixture-private-key-material');
    expect(safe).not.toContain('github_pat_fixtureOnlyToken0123456789');
    expect(safe).toContain('[REDACTED]');
  });

  it('keeps scanner JSON parseable when public or boolean settings have sensitive-looking names', () => {
    // COOKIE_SECURE=false once rewrote every `false` in OSV-Scanner's report, failing a clean scan
    vi.stubEnv('COOKIE_SECURE', 'false');
    vi.stubEnv('GITHUB_APP_ID', '123456');
    vi.stubEnv('ASEA_FEATURE_TOKEN_ENABLED', 'true');
    vi.stubEnv('ASEA_TEST_SECRET', SYNTHETIC_SECRET);
    const report = JSON.stringify({ results: [], experimental_config: { licenses: { summary: false, enabled: true } }, app: 123456, note: SYNTHETIC_SECRET });

    const safe = redactSensitiveText(report);
    const parsed = JSON.parse(safe);
    expect(parsed.experimental_config.licenses).toEqual({ summary: false, enabled: true });
    expect(parsed.app).toBe(123456);
    expect(parsed.note).toBe('[REDACTED]');
  });

  it('masks a configured secret fragment at a truncated stream boundary', () => {
    vi.stubEnv('ASEA_TEST_SECRET', SYNTHETIC_SECRET);
    const safe = redactSensitiveText(`earlier output ${SYNTHETIC_SECRET.slice(0, 20)}`, { outputTruncated: true });
    expect(safe).not.toContain(SYNTHETIC_SECRET.slice(0, 20));
    expect(safe).toContain('[REDACTED]');
  });

  it('redacts short exact sensitive environment values without logging them', () => {
    const shortSecret = 'Q7!x';
    vi.stubEnv('ASEA_SHORT_TEST_TOKEN', shortSecret);
    const safe = redactSensitiveText(`provider exception: ${shortSecret}`);
    expect(safe).not.toContain(shortSecret);
    expect(safe).toContain('[REDACTED]');
  });

  it('redacts nested persisted evidence and keeps the combined output under its byte budget', () => {
    vi.stubEnv('ASEA_TEST_SECRET', SYNTHETIC_SECRET);
    const evidence = redactSensitiveData({
      stdout: `test printed ${SYNTHETIC_SECRET}`,
      nested: [{ stderr: `assertion failed: ${SYNTHETIC_SECRET}`, accessToken: 'short-fixture-token' }],
    });
    expect(JSON.stringify(evidence)).not.toContain(SYNTHETIC_SECRET);
    expect((evidence as any).nested[0].accessToken).toBe('[REDACTED]');

    const output = redactOutputPair(`${'x'.repeat(900)} API_TOKEN=${SYNTHETIC_SECRET}${'y'.repeat(900)}`, 'z'.repeat(900), 1024, false);
    expect(output.outputTruncated).toBe(true);
    expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(1024);
    expect(`${output.stdout}${output.stderr}`).not.toContain(SYNTHETIC_SECRET);
  });
});
