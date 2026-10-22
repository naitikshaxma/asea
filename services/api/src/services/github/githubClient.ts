import { config } from '../../config.js';

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

/**
 * Posts a comment on a pull request (the issues comments endpoint) with
 * GITHUB_TOKEN. Network errors, 429 and 5xx are retried with a short backoff;
 * other 4xx responses are not.
 */
export async function postPullRequestComment(repository: string, pullNumber: number, body: string): Promise<{ url: string | null }> {
  if (!config.GITHUB_TOKEN) {
    throw new GithubApiError('GITHUB_TOKEN is not configured', false);
  }
  const [owner, name] = repository.split('/');
  const url = `${config.GITHUB_API_URL.replace(/\/$/, '')}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/issues/${pullNumber}/comments`;

  let lastError: GithubApiError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'asea-verifier',
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { html_url?: unknown };
        return { url: typeof json.html_url === 'string' ? json.html_url : null };
      }
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new GithubApiError(`GitHub returned ${res.status}: ${(await res.text()).slice(0, 200)}`, retryable);
    } catch (err) {
      lastError = new GithubApiError(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (!lastError.retryable || attempt === MAX_ATTEMPTS) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  throw lastError!;
}
