import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { PatchProposalError, requestPatchProposal } from '../../src/services/engineering/patchProposalClient.js';

describe('internal model-backed patch proposal client', () => {
  const originalUrl = config.AI_SERVICE_URL;
  const originalToken = config.INTERNAL_SERVICE_TOKEN;
  const originalTimeout = config.AI_SERVICE_TIMEOUT_MS;

  afterEach(() => {
    vi.unstubAllGlobals();
    config.AI_SERVICE_URL = originalUrl;
    config.INTERNAL_SERVICE_TOKEN = originalToken;
    config.AI_SERVICE_TIMEOUT_MS = originalTimeout;
  });

  it('sends bounded source context only to the internal provider and validates its response', async () => {
    config.AI_SERVICE_URL = 'http://agent.test/';
    config.INTERNAL_SERVICE_TOKEN = 'internal-test-secret';
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://agent.test/api/v1/engineering/propose');
      expect(new Headers(init?.headers).get('X-Internal-Token')).toBe('internal-test-secret');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        task_id: 'task-1', requirement: 'Validate inputs', files: [{ path: 'src/app.ts', content: 'source' }],
      });
      return Response.json({ summary: 'Validate input', plan: ['Add validation'], evidence: ['src/app.ts:1 confirms the handler'], unified_diff: '--- a/x\n+++ b/x\n' });
    });
    vi.stubGlobal('fetch', fetch);

    const proposal = await requestPatchProposal({
      taskId: 'task-1', requirement: 'Validate inputs', files: [{ path: 'src/app.ts', content: 'source' }],
    });
    expect(proposal.summary).toBe('Validate input');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not call the provider when the internal token is missing', async () => {
    config.INTERNAL_SERVICE_TOKEN = undefined;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(requestPatchProposal({ taskId: 't', requirement: 'Do something', files: [{ path: 'x', content: 'y' }] }))
      .rejects.toBeInstanceOf(PatchProposalError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports provider unavailability and rejects malformed provider data', async () => {
    config.INTERNAL_SERVICE_TOKEN = 'internal-test-secret';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ summary: 'not enough data', plan: [], unified_diff: '' })));
    const input = { taskId: 't', requirement: 'Do something', files: [{ path: 'x', content: 'y' }] };
    await expect(requestPatchProposal(input)).rejects.toThrow(/provider is unavailable/);
    await expect(requestPatchProposal(input)).rejects.toThrow(/invalid proposal/);
  });
});
