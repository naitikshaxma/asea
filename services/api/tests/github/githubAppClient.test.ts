import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { GithubAppClient } from '../../src/services/github/githubAppClient.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const appConfig = { GITHUB_APP_ID: '12345', GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_CLIENT_SECRET: 'client-secret', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_API_URL: 'https://api.github.test' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('GitHub App REST boundary', () => {
  it('verifies installations using a short-lived RS256 App JWT and returns only installation metadata', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const token = headers.get('Authorization')?.slice('Bearer '.length) ?? '';
      const claims = jwt.decode(token) as jwt.JwtPayload;
      expect(claims.iss).toBe('12345');
      expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(8 * 60);
      return response({ id: 99, account: { login: 'octo-org', type: 'Organization' } });
    }) as unknown as typeof fetch;
    const client = new GithubAppClient(appConfig, fetcher);
    await expect(client.getInstallation('99')).resolves.toEqual({ id: '99', accountLogin: 'octo-org', accountType: 'Organization' });
    expect(fetcher).toHaveBeenCalledWith('https://api.github.test/app/installations/99', expect.any(Object));
  });

  it('uses a short-lived installation token to list only sanitized repository metadata', async () => {
    const seenAuthorization: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('Authorization') ?? '';
      seenAuthorization.push(authorization);
      if (url.endsWith('/access_tokens')) return response({ token: 'ghs-temporary-secret' });
      return response({ repositories: [{ id: 7, full_name: 'octo-org/app', private: true, default_branch: 'main' }] });
    }) as unknown as typeof fetch;
    const client = new GithubAppClient(appConfig, fetcher);
    const repositories = await client.listInstallationRepositories('99');
    expect(repositories).toEqual([{ id: 7, full_name: 'octo-org/app', private: true, default_branch: 'main' }]);
    expect(seenAuthorization[0]).toMatch(/^Bearer eyJ/); // App JWT
    expect(seenAuthorization[1]).toBe('Bearer ghs-temporary-secret');
    expect(JSON.stringify(repositories)).not.toContain('ghs-temporary-secret');
  });

  it('checks installation access with a one-time user authorization code without retaining the user token', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.github.test/login/oauth/access_token') {
        expect(init?.method).toBe('POST');
        const params = new URLSearchParams(String(init?.body));
        expect(params.get('client_id')).toBe('Iv1.test');
        expect(params.get('client_secret')).toBe('client-secret');
        expect(params.get('code')).toBe('single-use-code');
        return response({ access_token: 'ghu-short-lived-user-token' });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ghu-short-lived-user-token');
      return response({ installations: [{ id: 99, account: { login: 'octo-org', type: 'Organization' } }] });
    }) as unknown as typeof fetch;
    const client = new GithubAppClient(appConfig, fetcher);
    await expect(client.verifyUserCanAccessInstallation('99', 'single-use-code')).resolves.toBe(true);
  });

  it('uses GitHub.com OAuth endpoint when configured with the public GitHub API', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return response({ access_token: 'ghu-short-lived-user-token' });
      }
      expect(url).toBe('https://api.github.com/user/installations?per_page=100&page=1');
      return response({ installations: [{ id: 99, account: { login: 'octo-org', type: 'Organization' } }] });
    }) as unknown as typeof fetch;
    const client = new GithubAppClient({ ...appConfig, GITHUB_API_URL: 'https://api.github.com' }, fetcher);
    await expect(client.verifyUserCanAccessInstallation('99', 'single-use-code')).resolves.toBe(true);
    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://github.com/login/oauth/access_token', expect.any(Object));
  });

  it('sanitizes and bounds actual check-run and latest commit status responses', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return response({ token: 'ghs-temporary-secret' });
      if (url.includes('/annotations')) return response([
        { path: 'src/handler.ts', start_line: 12, end_line: 12, annotation_level: 'failure', title: 'Type error', message: 'Unexpected github_pat_12345678901234567890' },
        { path: '../.env', start_line: 1, annotation_level: 'warning', message: 'Unsafe path' },
      ]);
      if (url.includes('/check-runs?')) return response({ check_runs: [
        { id: 7, name: 'build', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/acme/app/runs/7', output: { summary: 'Build failed with token=secret-value' } },
        { id: 8, name: 'external', status: 'completed', conclusion: 'success', details_url: 'https://evil.example/steal' },
      ] });
      return response([
          { context: 'lint', state: 'success', target_url: 'https://github.com/acme/app/actions/runs/1' },
          { context: 'lint', state: 'failure', target_url: 'https://github.com/acme/app/actions/runs/0' },
        ]);
    }) as unknown as typeof fetch;
    const client = new GithubAppClient(appConfig, fetcher);
    const checks = await client.getCiChecks('99', 'acme', 'app', 'a'.repeat(40));
    expect(checks).toEqual([
      {
        name: 'build', status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/acme/app/runs/7',
        failureSummary: 'Build failed with token=[REDACTED]',
        annotations: [
          { path: 'src/handler.ts', startLine: 12, endLine: 12, level: 'failure', title: 'Type error', message: 'Unexpected [REDACTED_GITHUB_TOKEN]' },
          { path: null, startLine: 1, endLine: null, level: 'warning', title: null, message: 'Unsafe path' },
        ],
      },
      { name: 'external', status: 'completed', conclusion: 'success', detailsUrl: null },
      { name: 'lint', status: 'success', conclusion: 'success', detailsUrl: 'https://github.com/acme/app/actions/runs/1' },
    ]);
  });
});
