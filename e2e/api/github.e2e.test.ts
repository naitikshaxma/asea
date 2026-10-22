import { createHmac, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, addDemoRepository, branchShas, registerUser, waitForRun, type Session } from '../support/api.js';

// The GitHub flow through the real stack: a signed pull_request delivery
// starts a verification, and the worker posts the result as a PR comment to
// the fake GitHub API (compose.e2e.yaml) that records it.
const GITHUB_MOCK = process.env['ASEA_GITHUB_MOCK_URL'] ?? 'http://localhost:18099';

describe('GitHub webhook end to end', () => {
  let session: Session;
  let repositoryId: string;
  let shas: Record<string, string>;
  let secret: string;
  const fullName = `asea-e2e/demo-${randomUUID().slice(0, 8)}`;

  const deliver = async (event: string, payload: object, opts: { secret?: string; delivery?: string } = {}) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', opts.secret ?? secret).update(body).digest('hex')}`;
    const res = await fetch(`${BASE_URL}/api/v1/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': opts.delivery ?? randomUUID(),
        'X-Hub-Signature-256': signature,
      },
      body,
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const pullRequest = (number: number, head: string) => ({
    action: 'opened',
    number,
    pull_request: {
      number,
      title: 'Add GET /projects/export',
      body: 'Only authenticated users may export their projects.',
      html_url: `https://github.com/${fullName}/pull/${number}`,
      user: { login: 'copilot[bot]', type: 'Bot' },
      labels: [],
      base: { sha: shas['main'], ref: 'main' },
      head: { sha: head, ref: 'demo/missing_auth' },
    },
    repository: { full_name: fullName },
  });

  beforeAll(async () => {
    session = await registerUser('github');
    repositoryId = await addDemoRepository(session, 'demo_app (GitHub)');
    shas = await branchShas(session, repositoryId);
    const connected = await session.client.request('PUT', `/api/v1/workspaces/${session.workspaceId}/repositories/${repositoryId}/github`, { fullName });
    expect(connected.status).toBe(200);
    secret = connected.body.webhookSecret;
    expect(connected.body.webhookUrl).toMatch(/\/api\/v1\/webhooks\/github$/);
  });

  it('acknowledges a signed ping and rejects an unsigned or wrongly signed delivery', async () => {
    expect(await deliver('ping', { zen: 'hi', repository: { full_name: fullName } })).toMatchObject({ status: 200, body: { ok: true } });
    expect((await deliver('pull_request', pullRequest(1, shas['demo/missing_auth']!), { secret: 'wrong' })).status).toBe(401);
    const unsigned = await fetch(`${BASE_URL}/api/v1/webhooks/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': randomUUID() },
      body: JSON.stringify({ repository: { full_name: fullName } }),
    });
    expect(unsigned.status).toBe(401);
  });

  it('verifies the pull request and posts score, verdict and top findings on it', async () => {
    const delivery = randomUUID();
    const accepted = await deliver('pull_request', pullRequest(42, shas['demo/missing_auth']!), { delivery });
    expect(accepted.status).toBe(202);
    expect(accepted.body.verifications).toEqual([
      { workspaceId: session.workspaceId, repositoryId, taskId: expect.any(String), created: true },
    ]);
    const taskId = accepted.body.verifications[0].taskId;

    // Redelivery of the same delivery does not start a second verification
    const again = await deliver('pull_request', pullRequest(42, shas['demo/missing_auth']!), { delivery });
    expect(again.body.verifications[0]).toMatchObject({ taskId, created: false });

    const run = await waitForRun(session, taskId);
    expect(run).toMatchObject({ status: 'COMPLETED', verdict: 'HIGH_RISK', authorType: 'AI' });
    expect(run.requirement).toBe('Add GET /projects/export\n\nOnly authenticated users may export their projects.');

    // The comment is posted right after the run completes
    let detail: any;
    for (let i = 0; i < 30; i++) {
      detail = (await session.client.get(`/api/v1/workspaces/${session.workspaceId}/verification-runs/${run.id}`)).body;
      if (detail.github?.comment) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(detail.github).toMatchObject({ repository: fullName, pullNumber: 42, deliveryId: delivery, comment: { status: 'POSTED', error: null } });

    const comments = (await (await fetch(`${GITHUB_MOCK}/__comments`)).json()) as any[];
    const posted = comments.filter((c) => `${c.owner}/${c.repo}` === fullName && c.number === 42);
    expect(posted).toHaveLength(1);
    expect(posted[0].headers.apiVersion).toBe('2022-11-28');
    const body: string = posted[0].body;
    expect(body).toContain(`🟠 HIGH RISK · score ${run.score}/100`);
    expect(body).toContain('| HIGH | Route handler has no authentication decorator | `routes/projects.py:25` |');
    expect(body).toContain(`/runs/${run.id})`);
    expect(detail.github.comment.url).toBe(`https://github.com/${fullName}/pull/42#issuecomment-${posted[0].id}`);
  });

  it('ignores events and actions that do not change code', async () => {
    expect(await deliver('issues', { action: 'opened', repository: { full_name: fullName } })).toMatchObject({ status: 202, body: { accepted: false } });
    const closed = { ...pullRequest(43, shas['demo/clean']!), action: 'closed' };
    expect(await deliver('pull_request', closed)).toMatchObject({ status: 202, body: { accepted: false } });
  });
});
