import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_POLICY_CONFIG, type PipelineResult, type VerificationRequest } from '@autonomous-engineer/contracts';
import { config } from '../../src/config.js';
import { getIndexStatus, indexFiles, requestScore, runPipeline } from '../../src/services/verification/agentClient.js';

const request: VerificationRequest = {
  repository_id: 'repo-1',
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  requirement: 'r',
  unified_diff: '',
  changed_files: [],
  author_type: 'human',
};

const finding = {
  id: 'f1',
  category: 'static' as const,
  severity: 'high' as const,
  title: 'eval',
  file: 'a.py',
  line: 1,
  evidence: ['eval(x)'],
  source: 'deterministic' as const,
  rule_id: 'ASEA-PY-EVAL-EXEC',
  remediation: 'Avoid eval.',
};

const score = {
  score: 65,
  verdict: 'high_risk' as const,
  raw_score: 65,
  total_deduction: 35,
  policy_hash: 'c'.repeat(64),
  breakdown: [],
  caps_applied: [],
  adjustments: [],
};

const agentRun = (name: 'ingest' | 'static') => ({
  name,
  status: 'completed' as const,
  started_at: '2026-10-22T10:00:00.000Z',
  finished_at: '2026-10-22T10:00:01.000Z',
  duration_ms: 1000,
  attempts: 1,
  finding_count: 0,
  detail: null,
  error: null,
});

const result: PipelineResult = {
  findings: [finding],
  static: { tools_run: ['python-ast'], tools_unavailable: ['semgrep'], duration_ms: 3, semgrep_ruleset_sha256: null, finding_count: 1 },
  score,
  report: { summary: 'High risk.', explanations: [{ finding_id: 'f1', explanation: 'x', suggested_fix: 'y' }], generated_by: 'llm' },
  agents: [agentRun('ingest')],
  llm: { provider: 'fake', model: 'fake-deterministic-v1' },
  complete: true,
};

/** A Response whose body arrives in the given chunks (lines may be split across chunks). */
function streamed(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status, headers: { 'Content-Type': 'application/x-ndjson' } }
  );
}

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

  it('streams the pipeline: forwards progress events in order and resolves with the result', async () => {
    const lines = [
      { type: 'agent_started', agent: 'ingest', at: '2026-10-22T10:00:00.000Z' },
      { type: 'agent_finished', run: agentRun('ingest') },
      { type: 'result', result },
    ].map((e) => JSON.stringify(e) + '\n');
    const joined = lines.join('');
    // Split mid-line to check buffering across chunks
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamed([joined.slice(0, 30), joined.slice(30, 90), joined.slice(90)]));
    const events: string[] = [];

    await expect(runPipeline({ request, policy: DEFAULT_POLICY_CONFIG }, (e) => void events.push(e.type))).resolves.toEqual(result);
    expect(events).toEqual(['agent_started', 'agent_finished']);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://agent.internal:8000/api/v1/verify');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Internal-Token']).toBe('shared-token');
    expect(headers['Accept']).toBe('application/x-ndjson');
    expect(JSON.parse(String(init?.body))).toEqual({ request, policy: DEFAULT_POLICY_CONFIG });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects on an error event, a stream without a result, or an event outside the contract', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      streamed([JSON.stringify({ type: 'error', code: 'INVALID_VERIFICATION_INPUT', message: 'bad path' }) + '\n'])
    );
    await expect(runPipeline({ request, policy: DEFAULT_POLICY_CONFIG }, () => {})).rejects.toThrow(
      'Verification pipeline failed (INVALID_VERIFICATION_INPUT): bad path'
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      streamed([JSON.stringify({ type: 'agent_started', agent: 'ingest', at: 'now' }) + '\n'])
    );
    await expect(runPipeline({ request, policy: DEFAULT_POLICY_CONFIG }, () => {})).rejects.toThrow(/ended without a result/);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(streamed([JSON.stringify({ type: 'result', result: { ...result, complete: 'yes' } }) + '\n']));
    await expect(runPipeline({ request, policy: DEFAULT_POLICY_CONFIG }, () => {})).rejects.toThrow();
  });

  it('checks and builds the repository index', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ repository_id: 'repo-1', commit_sha: 'abc', indexed: false, symbols: 0 })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repository_id: 'repo-1', commit_sha: 'abc', indexed_files: 1, symbols: 2, cached: false, complete: true }))
      );

    expect(await getIndexStatus('repo-1', 'abc')).toMatchObject({ indexed: false });
    const files = [{ path: 'a.py', content: 'def f():\n    pass\n' }];
    expect(await indexFiles({ repository_id: 'repo-1', commit_sha: 'abc', files, complete: true })).toMatchObject({ symbols: 2 });

    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://agent.internal:8000/api/v1/index/repo-1/abc');
    expect(fetchSpy.mock.calls[0]![1]?.method).toBe('GET');
    expect(String(fetchSpy.mock.calls[1]![0])).toBe('http://agent.internal:8000/api/v1/index');
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]?.body))).toEqual({ repository_id: 'repo-1', commit_sha: 'abc', files, complete: true });
  });

  it('POSTs findings and policy to the scoring node and validates the score result', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(score), { status: 200 }));
    const body = { findings: [finding], policy: DEFAULT_POLICY_CONFIG };

    await expect(requestScore(body)).resolves.toEqual(score);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://agent.internal:8000/api/v1/verify/score');
    expect(JSON.parse(String(init?.body))).toEqual(body);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ ...score, verdict: 'maybe' }), { status: 200 }));
    await expect(requestScore(body)).rejects.toThrow();
  });

  it('fails without calling the service when INTERNAL_SERVICE_TOKEN is not configured', async () => {
    config.INTERNAL_SERVICE_TOKEN = undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(runPipeline({ request, policy: DEFAULT_POLICY_CONFIG }, () => {})).rejects.toThrow(/INTERNAL_SERVICE_TOKEN is not configured/);
    await expect(getIndexStatus('r', 's')).rejects.toThrow(/INTERNAL_SERVICE_TOKEN is not configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"error":"nope"}', { status: 401 }));
    await expect(runPipeline({ request, policy: DEFAULT_POLICY_CONFIG }, () => {})).rejects.toThrow(/returned 401 for the verification pipeline/);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('busy', { status: 503 }));
    await expect(indexFiles({ repository_id: 'r', commit_sha: 's', files: [], complete: true })).rejects.toThrow(/returned 503 for indexing/);
  });
});
