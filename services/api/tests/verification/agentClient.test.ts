import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VerificationRequest } from '@autonomous-engineer/contracts';
import { config } from '../../src/config.js';
import { requestStaticAnalysis } from '../../src/services/verification/agentClient.js';

const request: VerificationRequest = {
  repository_id: 'repo-1',
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  requirement: 'r',
  unified_diff: '',
  changed_files: [],
  author_type: 'human',
};

const result = {
  findings: [
    {
      id: 'f1',
      category: 'static',
      severity: 'high',
      title: 'eval',
      file: 'a.py',
      line: 1,
      evidence: ['eval(x)'],
      source: 'deterministic',
      rule_id: 'ASEA-PY-EVAL-EXEC',
      remediation: 'Avoid eval.',
    },
  ],
  tools_run: ['python-ast'],
  tools_unavailable: ['semgrep'],
  duration_ms: 3,
};

describe('agent service client', () => {
  const original = { url: config.AI_SERVICE_URL, token: config.INTERNAL_SERVICE_TOKEN };

  beforeEach(() => {
    config.AI_SERVICE_URL = 'http://agent.internal:8000';
    config.INTERNAL_SERVICE_TOKEN = 'shared-token';
  });

  afterEach(() => {
    config.AI_SERVICE_URL = original.url;
    config.INTERNAL_SERVICE_TOKEN = original.token;
    vi.restoreAllMocks();
  });

  it('POSTs the request to AI_SERVICE_URL with the internal token and validates the result', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));

    await expect(requestStaticAnalysis(request)).resolves.toEqual(result);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://agent.internal:8000/api/v1/verify/static');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['X-Internal-Token']).toBe('shared-token');
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails without calling the service when INTERNAL_SERVICE_TOKEN is not configured', async () => {
    config.INTERNAL_SERVICE_TOKEN = undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(requestStaticAnalysis(request)).rejects.toThrow(/INTERNAL_SERVICE_TOKEN is not configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails on a non-2xx response or a result outside the contract', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"error":"nope"}', { status: 401 }));
    await expect(requestStaticAnalysis(request)).rejects.toThrow(/returned 401/);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ...result, duration_ms: -1 }), { status: 200 })
    );
    await expect(requestStaticAnalysis(request)).rejects.toThrow();
  });
});
