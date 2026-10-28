import jwt from 'jsonwebtoken';
import type { EnvConfig } from '../../config.js';

export class GithubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GithubApiError';
  }
}

export interface GithubInstallationInfo {
  id: string;
  accountLogin: string;
  accountType: string;
}

export interface GithubInstallationRepository {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

export interface GithubRef {
  sha: string;
}

export interface GithubContentFile {
  type: string;
  encoding: string;
  content: string;
  size: number;
}

export interface GithubCommit {
  sha: string;
  tree: { sha: string };
  message?: string;
}

export interface GithubPullRequest {
  number: number;
  html_url: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}

export interface GithubCheckSummary {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  failureSummary?: string | null;
  annotations?: GithubCheckAnnotation[];
}

export interface GithubCheckAnnotation {
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  level: string;
  title: string | null;
  message: string;
}

const FAILING_CHECK_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

type FetchLike = typeof fetch;
type GithubAppConfig = Pick<EnvConfig, 'GITHUB_APP_ID' | 'GITHUB_APP_CLIENT_ID' | 'GITHUB_APP_CLIENT_SECRET' | 'GITHUB_APP_PRIVATE_KEY' | 'GITHUB_API_URL'>;

/** Server-side GitHub App REST boundary. Tokens and App keys never leave this module. */
export class GithubAppClient {
  private readonly fetcher: FetchLike;
  private readonly appId: string;
  private readonly apiUrl: string;
  private readonly privateKey: string;
  private readonly configClientId?: string;
  private readonly configClientSecret?: string;

  constructor(config: GithubAppConfig, fetcher: FetchLike = fetch) {
    if (!config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY) throw new Error('GitHub App is not configured');
    this.appId = config.GITHUB_APP_ID;
    this.apiUrl = config.GITHUB_API_URL.replace(/\/$/, '');
    this.privateKey = config.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
    this.configClientId = config.GITHUB_APP_CLIENT_ID;
    this.configClientSecret = config.GITHUB_APP_CLIENT_SECRET;
    this.fetcher = fetcher;
  }

  private createAppJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ iat: now - 60, exp: now + 7 * 60, iss: this.appId }, this.privateKey, { algorithm: 'RS256' });
  }

  private async request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.apiUrl}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ASEA-GitHub-App',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!response.ok) {
      const message = body && typeof body === 'object' && typeof (body as Record<string, unknown>).message === 'string'
        ? String((body as Record<string, unknown>).message).slice(0, 240)
        : `GitHub API request failed with HTTP ${response.status}`;
      throw new GithubApiError(response.status, message);
    }
    return body as T;
  }

  async getInstallation(installationId: string): Promise<GithubInstallationInfo> {
    const result = await this.request<{ id: number; account?: { login?: string; type?: string } }>(
      `/app/installations/${encodeURIComponent(installationId)}`, this.createAppJwt()
    );
    if (!result.account?.login || !result.account.type) throw new GithubApiError(502, 'GitHub returned an incomplete installation record');
    return { id: String(result.id), accountLogin: result.account.login, accountType: result.account.type };
  }

  private async exchangeUserCode(code: string): Promise<string> {
    if (!this.configClientId || !this.configClientSecret) throw new Error('GitHub App user authorization is not configured');
    const api = new URL(this.apiUrl);
    const oauthOrigin = api.hostname === 'api.github.com' ? 'https://github.com' : api.origin;
    const tokenResponse = await this.fetcher(`${oauthOrigin}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ASEA-GitHub-App' },
      body: new URLSearchParams({ client_id: this.configClientId, client_secret: this.configClientSecret, code }),
      signal: AbortSignal.timeout(20_000),
    });
    const tokenBody = await tokenResponse.json().catch(() => ({})) as { access_token?: unknown };
    if (!tokenResponse.ok || typeof tokenBody.access_token !== 'string' || !tokenBody.access_token) {
      throw new GithubApiError(tokenResponse.status >= 400 ? tokenResponse.status : 401, 'GitHub user authorization code was rejected');
    }
    return tokenBody.access_token;
  }

  /** The returned list comes from the current GitHub user token and is safe to use as a selection allowlist. */
  async getUserAccessibleInstallations(code: string): Promise<GithubInstallationInfo[]> {
    const userToken = await this.exchangeUserCode(code);
    const all: GithubInstallationInfo[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.request<{ installations?: Array<{ id?: number; account?: { login?: string; type?: string } }> }>(
        `/user/installations?per_page=100&page=${page}`, userToken
      );
      const installations = Array.isArray(result.installations) ? result.installations : [];
      all.push(...installations.filter((item) => Number.isSafeInteger(item.id) && item.account?.login && item.account.type)
        .map((item) => ({ id: String(item.id), accountLogin: item.account!.login!, accountType: item.account!.type! })));
      if (installations.length < 100) return all;
    }
    throw new GithubApiError(413, 'The authenticated GitHub user has more than 1000 App installations');
  }

  async verifyUserCanAccessInstallation(installationId: string, code: string): Promise<boolean> {
    const installations = await this.getUserAccessibleInstallations(code);
    return installations.some((installation) => installation.id === installationId);
  }

  async createInstallationToken(installationId: string): Promise<string> {
    const result = await this.request<{ token?: string }>(
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, this.createAppJwt(), { method: 'POST', body: '{}' }
    );
    if (!result.token) throw new GithubApiError(502, 'GitHub did not return an installation token');
    return result.token;
  }

  async listInstallationRepositories(installationId: string): Promise<GithubInstallationRepository[]> {
    const token = await this.createInstallationToken(installationId);
    const all: GithubInstallationRepository[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.request<{ repositories?: GithubInstallationRepository[] }>(
        `/installation/repositories?per_page=100&page=${page}`, token
      );
      const repositories = Array.isArray(result.repositories) ? result.repositories : [];
      all.push(...repositories.filter((repo) => Number.isSafeInteger(repo.id) && typeof repo.full_name === 'string'));
      if (repositories.length < 100) return all;
    }
    throw new GithubApiError(413, 'The installation has more than 1000 repositories; narrow the installation before connecting it');
  }

  async installationRequest<T>(installationId: string, path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, await this.createInstallationToken(installationId), options);
  }

  async getRef(installationId: string, owner: string, repo: string, branch: string): Promise<GithubRef> {
    const result = await this.installationRequest<{ object?: { sha?: string } }>(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!result.object?.sha) throw new GithubApiError(502, 'GitHub returned an incomplete branch reference');
    return { sha: result.object.sha };
  }

  async getContent(installationId: string, owner: string, repo: string, filePath: string, ref: string): Promise<GithubContentFile> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const result = await this.installationRequest<GithubContentFile>(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    if (result.type !== 'file' || result.encoding !== 'base64' || typeof result.content !== 'string') {
      throw new GithubApiError(422, 'Only regular text files can be published by this patch workflow');
    }
    return result;
  }

  async getCommit(installationId: string, owner: string, repo: string, sha: string): Promise<GithubCommit> {
    const result = await this.installationRequest<GithubCommit>(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`);
    if (!result.tree?.sha) throw new GithubApiError(502, 'GitHub returned an incomplete commit');
    return result;
  }

  async createBlob(installationId: string, owner: string, repo: string, contentBase64: string): Promise<string> {
    const result = await this.installationRequest<{ sha?: string }>(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
      { method: 'POST', body: JSON.stringify({ content: contentBase64, encoding: 'base64' }) });
    if (!result.sha) throw new GithubApiError(502, 'GitHub did not return the created blob SHA');
    return result.sha;
  }

  async createTree(installationId: string, owner: string, repo: string, baseTree: string, entries: Array<{ path: string; sha: string }>): Promise<string> {
    const result = await this.installationRequest<{ sha?: string }>(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
      { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree: entries.map((entry) => ({ path: entry.path, mode: '100644', type: 'blob', sha: entry.sha })) }) });
    if (!result.sha) throw new GithubApiError(502, 'GitHub did not return the created tree SHA');
    return result.sha;
  }

  async createCommit(installationId: string, owner: string, repo: string, message: string, tree: string, parent: string): Promise<string> {
    const result = await this.installationRequest<{ sha?: string }>(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
      { method: 'POST', body: JSON.stringify({ message, tree, parents: [parent] }) });
    if (!result.sha) throw new GithubApiError(502, 'GitHub did not return the created commit SHA');
    return result.sha;
  }

  async createRef(installationId: string, owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.installationRequest(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
  }

  async listOpenPullRequests(installationId: string, owner: string, repo: string, branch: string, base: string): Promise<GithubPullRequest[]> {
    const head = `${owner}:${branch}`;
    const result = await this.installationRequest<GithubPullRequest[]>(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100&head=${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`);
    return Array.isArray(result) ? result : [];
  }

  async createPullRequest(installationId: string, owner: string, repo: string, title: string, body: string, head: string, base: string): Promise<GithubPullRequest> {
    return this.installationRequest<GithubPullRequest>(installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      { method: 'POST', body: JSON.stringify({ title, body, head, base }) });
  }

  async getCommitMessage(installationId: string, owner: string, repo: string, sha: string): Promise<string> {
    const result = await this.getCommit(installationId, owner, repo, sha);
    return result.message ?? '';
  }

  async getCiChecks(installationId: string, owner: string, repo: string, sha: string): Promise<GithubCheckSummary[]> {
    const token = await this.createInstallationToken(installationId);
    const [checks, statuses] = await Promise.all([
      this.request<{ check_runs?: Array<{
        id?: number; name?: string; status?: string; conclusion?: string | null; details_url?: string | null;
        output?: { title?: string | null; summary?: string | null };
      }> }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`, token),
      this.request<Array<{ context?: string; state?: string; target_url?: string | null }>>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/statuses`, token),
    ]);
    const checkRuns = Array.isArray(checks.check_runs) ? checks.check_runs.slice(0, 100) : [];
    const failedRuns = checkRuns.filter((check) => Number.isSafeInteger(check.id) && check.id! > 0
      && FAILING_CHECK_CONCLUSIONS.has(String(check.conclusion ?? '').toLowerCase()))
      .slice(0, 10);
    const annotationsByRun = new Map<number, GithubCheckAnnotation[]>();
    await Promise.all(failedRuns.map(async (check) => {
      try {
        const annotations = await this.request<unknown>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${check.id}/annotations?per_page=25`, token);
        annotationsByRun.set(check.id!, sanitizeAnnotations(annotations));
      } catch {
        // Check summaries and statuses remain useful when annotations are not available.
      }
    }));
    const fromChecks = checkRuns.map((check) => {
      const isFailure = FAILING_CHECK_CONCLUSIONS.has(String(check.conclusion ?? '').toLowerCase());
      const annotations = Number.isSafeInteger(check.id) ? annotationsByRun.get(check.id!) : undefined;
      return {
      name: String(check.name ?? 'Unnamed check').slice(0, 120),
      status: String(check.status ?? 'unknown').slice(0, 32),
      conclusion: check.conclusion ? String(check.conclusion).slice(0, 32) : null,
      detailsUrl: safeGithubUrl(check.details_url),
      ...(isFailure ? { failureSummary: sanitizeGithubText(check.output?.summary, 1600) } : {}),
      ...(annotations?.length ? { annotations } : {}),
    };
    });
    const latestStatusByContext = new Map<string, (typeof statuses)[number]>();
    for (const status of Array.isArray(statuses) ? statuses : []) {
      const context = String(status.context ?? 'Commit status');
      if (!latestStatusByContext.has(context)) latestStatusByContext.set(context, status);
    }
    const fromStatuses = [...latestStatusByContext.values()].map((status) => ({
      name: String(status.context ?? 'Commit status').slice(0, 120),
      status: String(status.state ?? 'unknown').slice(0, 32),
      conclusion: String(status.state ?? 'unknown').slice(0, 32),
      detailsUrl: safeGithubUrl(status.target_url),
    }));
    return [...fromChecks, ...fromStatuses];
  }
}

function sanitizeAnnotations(value: unknown): GithubCheckAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).flatMap((item): GithubCheckAnnotation[] => {
    if (!item || typeof item !== 'object') return [];
    const annotation = item as Record<string, unknown>;
    const path = safeAnnotationPath(annotation['path']);
    return [{
      path,
      startLine: positiveLine(annotation['start_line']),
      endLine: positiveLine(annotation['end_line']),
      level: typeof annotation['annotation_level'] === 'string' ? annotation['annotation_level'].slice(0, 24) : 'unknown',
      title: sanitizeGithubText(annotation['title'], 200),
      message: sanitizeGithubText(annotation['message'], 1000) ?? 'GitHub reported a check annotation without a message.',
    }];
  });
}

function positiveLine(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeAnnotationPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return value.slice(0, 512);
}

function sanitizeGithubText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/\b(password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, limit).trim() || null;
}

function safeGithubUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && (parsed.hostname === 'github.com' || parsed.hostname.endsWith('.github.com')) ? parsed.toString() : null;
  } catch { return null; }
}
