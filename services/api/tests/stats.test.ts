import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { config } from '../src/config.js';
import { generateToken } from '../src/services/authService.js';

describe('Dashboard stats and system status', () => {
  const app = createApp();
  const workspaceId = 'ws-s';
  const token = generateToken({ userId: 'user-s', email: 's@example.com' });
  const run = {
    id: 'vr-s',
    workspaceId,
    repositoryId: 'repo-s',
    taskId: 'task-s',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    requirement: 'r',
    authorType: 'AI',
    status: 'COMPLETED',
    score: 65,
    verdict: 'HIGH_RISK',
    policyProfileId: null,
    policyHash: null,
    github: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-10-22T08:00:00Z'),
    _count: { findings: 1 },
    repository: { name: 'demo_app' },
    task: { title: 'Export' },
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValue({
      id: 'm', workspaceId, userId: 'user-s', role: 'MEMBER', createdAt: new Date(), workspace: { id: workspaceId, name: 'S', ownerId: 'user-s' },
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const get = (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`);

  it('aggregates runs, verdicts, score and findings in the database and zero-fills 14 days of activity', async () => {
    vi.spyOn(prisma.verificationRun, 'groupBy').mockImplementation((async (args: any) =>
      args.by[0] === 'status'
        ? [{ status: 'COMPLETED', _count: { _all: 3 } }, { status: 'RUNNING', _count: { _all: 1 } }]
        : [{ verdict: 'ALLOW', _count: { _all: 2 } }, { verdict: 'HIGH_RISK', _count: { _all: 1 } }]) as any);
    vi.spyOn(prisma.verificationRun, 'aggregate').mockResolvedValue({ _avg: { score: 88.3333 } } as any);
    vi.spyOn(prisma.verificationFinding, 'groupBy').mockResolvedValue([{ severity: 'HIGH', _count: { _all: 4 } }] as any);
    const raw = vi.spyOn(prisma, '$queryRaw').mockResolvedValue([
      { day: new Date('2026-10-20T00:00:00Z'), runs: 1 },
      { day: new Date('2026-10-22T00:00:00Z'), runs: 3 },
    ] as any);
    const findMany = vi.spyOn(prisma.verificationRun, 'findMany').mockResolvedValue([run] as any);

    const res = await get(`/api/v1/workspaces/${workspaceId}/stats`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalRuns: 4,
      byStatus: { COMPLETED: 3, RUNNING: 1 },
      byVerdict: { ALLOW: 2, HIGH_RISK: 1 },
      averageScore: 88.3,
      findingsBySeverity: { HIGH: 4 },
    });
    expect(res.body.activity).toHaveLength(14);
    expect(res.body.activity[0]).toEqual({ date: '2026-10-09', runs: 0 });
    expect(res.body.activity.at(-3)).toEqual({ date: '2026-10-20', runs: 1 });
    expect(res.body.activity.at(-1)).toEqual({ date: '2026-10-22', runs: 3 });
    expect(res.body.recentRuns).toEqual([expect.objectContaining({ id: 'vr-s', repositoryName: 'demo_app', title: 'Export', verdict: 'HIGH_RISK' })]);
    // Scoped to the workspace; one query per figure (no per-run queries)
    expect(raw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId }, take: 5 }));
    expect(prisma.verificationFinding.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { verificationRun: { workspaceId } } }));
  });

  it('reports an empty workspace honestly', async () => {
    vi.spyOn(prisma.verificationRun, 'groupBy').mockResolvedValue([] as any);
    vi.spyOn(prisma.verificationRun, 'aggregate').mockResolvedValue({ _avg: { score: null } } as any);
    vi.spyOn(prisma.verificationFinding, 'groupBy').mockResolvedValue([] as any);
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([] as any);
    vi.spyOn(prisma.verificationRun, 'findMany').mockResolvedValue([]);

    const res = await get(`/api/v1/workspaces/${workspaceId}/stats`);
    expect(res.body).toMatchObject({ totalRuns: 0, byStatus: {}, byVerdict: {}, averageScore: null, findingsBySeverity: {}, recentRuns: [] });
    expect(res.body.activity.every((d: any) => d.runs === 0)).toBe(true);
  });

  it('requires authentication and membership', async () => {
    expect((await request(app).get(`/api/v1/workspaces/${workspaceId}/stats`)).status).toBe(401);
    vi.mocked(prisma.workspaceMembership.findUnique).mockResolvedValue(null);
    expect((await get(`/api/v1/workspaces/${workspaceId}/stats`)).status).toBe(403);
  });

  describe('system status', () => {
    const original = { token: config.GITHUB_TOKEN, url: config.AI_SERVICE_URL, web: config.PUBLIC_WEB_URL };
    beforeEach(() => {
      config.AI_SERVICE_URL = 'http://agent.internal:8000';
      config.PUBLIC_WEB_URL = 'https://asea.example.com/';
    });
    afterEach(() => {
      config.GITHUB_TOKEN = original.token;
      config.AI_SERVICE_URL = original.url;
      config.PUBLIC_WEB_URL = original.web;
    });

    it('reports the engine readiness, LLM provider, code index and GitHub settings', async () => {
      config.GITHUB_TOKEN = 'ghp_x';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ready',
            dependencies: {
              llm_provider: { status: 'up', message: "LLM provider 'fake', model 'fake-deterministic-v1' (deterministic stand-in, no model is called)" },
              code_index: { status: 'up', message: 'Qdrant (http://qdrant:6333)' },
            },
          }),
          { status: 200 }
        )
      );
      const res = await get('/api/v1/system/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        engine: {
          status: 'up',
          llm: { status: 'up', message: "LLM provider 'fake', model 'fake-deterministic-v1' (deterministic stand-in, no model is called)" },
          codeIndex: { status: 'up', message: 'Qdrant (http://qdrant:6333)' },
        },
        sandbox: { provider: 'unavailable', status: 'UNAVAILABLE', image: null, reasonCode: 'NOT_CONFIGURED', message: 'No isolated execution provider is configured.' },
        github: { commentsEnabled: true, apiUrl: config.GITHUB_API_URL },
        publicWebUrl: 'https://asea.example.com',
        webhookUrl: 'https://asea.example.com/api/v1/webhooks/github',
      });
      expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://agent.internal:8000/ready');
    });

    it('reports an unreachable engine as down, and needs a session', async () => {
      config.GITHUB_TOKEN = undefined;
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      const res = await get('/api/v1/system/status');
      expect(res.body.engine).toEqual({ status: 'down', llm: null, codeIndex: null });
      expect(res.body.github.commentsEnabled).toBe(false);
      expect((await request(app).get('/api/v1/system/status')).status).toBe(401);
    });
  });
});
