import { describe, it, expect, beforeAll } from 'vitest';
import {
  DEMO_CASES,
  addDemoRepository,
  branchShas,
  expectedFindings,
  psql,
  registerUser,
  submitVerification,
  waitForRun,
  type Session,
} from '../support/api.js';

// The four seeded demo changes, verified through the real stack (API ->
// outbox -> BullMQ -> worker -> git -> Qdrant index -> LangGraph pipeline ->
// Postgres), each with its expected verdict, findings, agent timeline, report
// and an intact audit chain. The stack runs the agents with LLM_PROVIDER=fake.
describe('demo fixtures end to end', () => {
  let session: Session;
  let repositoryId: string;
  let shas: Record<string, string>;
  const runs = new Map<string, any>();
  const indexSteps: any[] = [];

  beforeAll(async () => {
    session = await registerUser('fixtures');
    repositoryId = await addDemoRepository(session);
    shas = await branchShas(session, repositoryId);
  });

  it('exposes the demo branches', () => {
    expect(Object.keys(shas).sort()).toEqual(['main', ...DEMO_CASES.map((c) => c.branch)].sort());
  });

  it.each(DEMO_CASES.map((c) => [c.case, c] as const))('%s gets its expected verdict and findings', async (_name, demo) => {
    const submitted = await submitVerification(session, {
      repositoryId,
      baseSha: shas['main']!,
      headSha: shas[demo.branch]!,
      title: demo.title,
      requirement: demo.requirement,
    });
    expect(submitted.status).toBe(201);

    const run = await waitForRun(session, submitted.body.id);
    runs.set(demo.case, run);
    expect(run.status).toBe('COMPLETED');
    expect(run.verdict).toBe(demo.expectedVerdict);

    const base = `/api/v1/workspaces/${session.workspaceId}/verification-runs/${run.id}`;
    const findings = (await session.client.get(`${base}/findings`)).body.findings;
    const deterministic = findings
      .filter((f: any) => f.source === 'DETERMINISTIC')
      .map((f: any) => ({ rule_id: f.ruleId, severity: f.severity.toLowerCase(), file: f.file, line: f.line }));
    const expected = expectedFindings(demo.case).map((f) => ({ rule_id: f.rule_id, severity: f.severity, file: f.file, line: f.line }));
    expect(deterministic.sort(byLocation)).toEqual(expected.sort(byLocation));

    const detail = (await session.client.get(base)).body;
    expect(detail.scoreBreakdown.score).toBe(run.score);
    expect(detail.scoreBreakdown.items).toHaveLength(findings.length);
    expect(detail.agentTimeline.map((a: any) => `${a.name}:${a.status}`)).toEqual([
      'ingest:completed',
      'static:completed',
      'negative_space:completed',
      'architecture:completed',
      'score:completed',
      'report:completed',
    ]);
    expect(detail.engine).toMatchObject({ llmProvider: 'fake', complete: true, toolsRun: expect.arrayContaining(['python-ast']) });
    expect(detail.report.summary).toContain(`score of ${run.score}/100`);
    expect(detail.report.explanations.map((e: any) => e.findingId).sort()).toEqual(findings.map((f: any) => f.findingId).sort());
    if (demo.case === 'missing_auth') {
      // Both agents found the missing login; it corroborates the deterministic finding instead of counting twice
      const [route] = findings;
      expect(route.evidence.some((e: string) => e.startsWith('Also reported by the negative-space agent'))).toBe(true);
      expect(route.evidence.some((e: string) => e.startsWith('Also reported by the architecture agent'))).toBe(true);
    }

    const task = (await session.client.get(`/api/v1/workspaces/${session.workspaceId}/tasks/${submitted.body.id}`)).body;
    const steps = task.runs[0].steps;
    expect(steps.map((s: any) => `${s.stepType}:${s.stepStatus}`)).toEqual([
      'VALIDATE_CONTEXT:COMPLETED',
      'INDEX_REPOSITORY:COMPLETED',
      'VERIFICATION_PIPELINE:COMPLETED',
    ]);
    indexSteps.push(steps[1].resultMetadata);

    const audit = (await session.client.get(`${base}/audit/verify`)).body;
    expect(audit).toMatchObject({
      valid: true,
      chain: { valid: true },
      seal: { valid: true },
      findingsDigestValid: true,
      scoreValid: true,
      reportValid: true,
    });
  });

  it('indexes the base commit once and reuses the cached index for later runs', () => {
    expect(indexSteps).toHaveLength(DEMO_CASES.length);
    expect(indexSteps[0]).toMatchObject({ cached: false, commitSha: shas['main'], files: 11 });
    expect(indexSteps[0].symbols).toBeGreaterThan(0);
    for (const later of indexSteps.slice(1)) {
      expect(later).toMatchObject({ cached: true, commitSha: shas['main'], files: 0, symbols: indexSteps[0].symbols });
    }
  });

  it('detects a score edited directly in the database', async () => {
    const run = runs.get('secret_and_sql');
    expect(run).toBeDefined();
    psql(`UPDATE "VerificationRun" SET score = 100, verdict = 'ALLOW' WHERE id = '${run.id}'`);
    const audit = (await session.client.get(`/api/v1/workspaces/${session.workspaceId}/verification-runs/${run.id}/audit/verify`)).body;
    expect(audit).toMatchObject({ valid: false, scoreValid: false, chain: { valid: true } });
  });
});

function byLocation(a: { file: string; line: number; rule_id: string }, b: { file: string; line: number; rule_id: string }) {
  return a.file.localeCompare(b.file) || a.line - b.line || a.rule_id.localeCompare(b.rule_id);
}
