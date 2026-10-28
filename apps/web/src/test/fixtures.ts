import type {
  AuditEventListResponse,
  PolicyProfileResponse,
  RepositoryResponse,
  VerificationFindingResponse,
  VerificationRunDetailResponse,
  VerificationRunResponse,
  WorkspaceStatsResponse,
} from '@autonomous-engineer/contracts';
import { DEFAULT_POLICY_CONFIG } from '@autonomous-engineer/contracts';
import type { Routes } from './mockApi';

export const NOW = '2026-10-22T10:00:00.000Z';
export const WS = 'ws-1';

export const user = { id: 'usr-1', email: 'dana@example.com', displayName: 'Dana Reviewer', accountStatus: 'ACTIVE', createdAt: NOW };
export const workspace = { id: WS, name: 'Platform Team', ownerId: 'usr-1', role: 'OWNER', createdAt: NOW, updatedAt: NOW };

export const repo: RepositoryResponse = {
  id: 'repo-1',
  workspaceId: WS,
  name: 'demo_app',
  provider: 'LOCAL',
  repositoryUrl: '/repos/demo_app',
  defaultBranch: 'main',
  connectionStatus: 'CONNECTED',
  githubFullName: null,
  githubWebhookConfigured: false,
  createdAt: NOW,
  updatedAt: NOW,
};

export const refs = {
  repositoryId: 'repo-1',
  defaultBranch: 'main',
  branches: [
    { name: 'demo/missing_auth', sha: 'b'.repeat(40), subject: 'Add GET /projects/export', committedAt: NOW },
    { name: 'main', sha: 'a'.repeat(40), subject: 'Demo app', committedAt: NOW },
  ],
};

export function makeRun(overrides: Partial<VerificationRunResponse> = {}): VerificationRunResponse {
  return {
    id: 'run-1',
    workspaceId: WS,
    repositoryId: 'repo-1',
    repositoryName: 'demo_app',
    title: 'Export projects',
    taskId: 'task-1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    requirement: 'Only authenticated users may export their projects.',
    authorType: 'AI',
    status: 'COMPLETED',
    score: 65,
    verdict: 'HIGH_RISK',
    policyProfileId: 'pol-1',
    policyHash: 'c'.repeat(64),
    github: null,
    findingCount: 1,
    startedAt: NOW,
    completedAt: '2026-10-22T10:00:02.000Z',
    createdAt: NOW,
    ...overrides,
  };
}

const timelineEntry = (name: string, extra: object = {}) => ({
  name,
  status: 'completed',
  startedAt: NOW,
  finishedAt: NOW,
  durationMs: 12,
  attempts: 1,
  findingCount: 0,
  detail: null,
  error: null,
  ...extra,
});

export function makeRunDetail(overrides: Partial<VerificationRunDetailResponse> = {}): VerificationRunDetailResponse {
  return {
    ...makeRun(),
    scoreBreakdown: {
      score: 65,
      verdict: 'HIGH_RISK',
      rawScore: 65,
      totalDeduction: 35,
      policyHash: 'c'.repeat(64),
      items: [
        {
          findingId: 'f-route',
          ruleId: 'ASEA-PY-ROUTE-NO-AUTH',
          title: 'Route handler has no authentication decorator',
          category: 'STATIC',
          severity: 'HIGH',
          source: 'DETERMINISTIC',
          severityWeight: 35,
          categoryMultiplier: 1,
          sourceMultiplier: 1,
          deduction: 35,
        },
      ],
      capsApplied: [],
    },
    policySnapshot: DEFAULT_POLICY_CONFIG,
    agentTimeline: [
      timelineEntry('ingest', { detail: '1 changed file(s)' }),
      timelineEntry('static', { findingCount: 1 }),
      timelineEntry('negative_space', { findingCount: 1, detail: '1 responsibilities checked, 1 missing' }),
      timelineEntry('architecture', { attempts: 2, findingCount: 1 }),
      timelineEntry('score', { findingCount: 1 }),
      timelineEntry('report'),
    ] as VerificationRunDetailResponse['agentTimeline'],
    report: {
      summary: 'High risk: the export route has no login check.',
      generatedBy: 'llm',
      explanations: [{ findingId: 'f-route', explanation: 'Anyone can export every project.', suggestedFix: 'Add @login_required to export_projects.' }],
    },
    engine: { llmProvider: 'fake', llmModel: 'fake-deterministic-v1', complete: true, toolsRun: ['python-ast'], toolsUnavailable: ['semgrep'], semgrepRulesetSha256: null },
    ...overrides,
  };
}

export const finding: VerificationFindingResponse = {
  id: 'row-1',
  findingId: 'f-route',
  category: 'STATIC',
  severity: 'HIGH',
  title: 'Route handler has no authentication decorator',
  file: 'routes/projects.py',
  line: 25,
  evidence: ['def export_projects():', 'Also reported by the architecture agent: export_projects does not use @login_required'],
  source: 'DETERMINISTIC',
  ruleId: 'ASEA-PY-ROUTE-NO-AUTH',
  remediation: 'Add the authentication decorator.',
};

export const auditEvents: AuditEventListResponse = {
  verificationRunId: 'run-1',
  events: ['VERIFICATION_STARTED', 'SCORE_COMPUTED', 'RUN_SEALED'].map((eventType, i) => ({
    id: `e${i}`,
    eventType,
    actorId: 'usr-1',
    metadata: {},
    timestamp: NOW,
    prevHash: i ? `${i - 1}`.repeat(64) : '0'.repeat(64),
    hash: `${i}`.repeat(64),
  })),
};

export function makeStats(overrides: Partial<WorkspaceStatsResponse> = {}): WorkspaceStatsResponse {
  return {
    totalRuns: 4,
    byStatus: { COMPLETED: 3, RUNNING: 1 },
    byVerdict: { ALLOW: 1, REVIEW: 1, HIGH_RISK: 1 },
    averageScore: 83.3,
    findingsBySeverity: { HIGH: 2, MEDIUM: 1 },
    activity: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(9 + i).padStart(2, '0')}`, runs: i === 13 ? 4 : 0 })),
    recentRuns: [makeRun(), makeRun({ id: 'run-2', title: 'Rename a project', verdict: 'ALLOW', score: 100, findingCount: 0 })],
    ...overrides,
  };
}

export const policy: PolicyProfileResponse = {
  id: 'pol-1',
  workspaceId: WS,
  name: 'default',
  description: 'Default policy. Its weights, caps and bands are uncalibrated placeholders; tune them for your team.',
  config: DEFAULT_POLICY_CONFIG,
  configHash: 'c'.repeat(64),
  isDefault: true,
  createdAt: NOW,
  updatedAt: NOW,
};

/** A signed-in owner with one workspace and an online API. */
export function signedIn(extra: Routes = {}, workspaces = [workspace]): Routes {
  return {
    'GET /api/v1/auth/me': { user, workspaces },
    'GET /ready': { status: 'ready', service: 'api', timestamp: NOW, dependencies: {} },
    ...extra,
  };
}
