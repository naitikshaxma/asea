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
// outbox -> BullMQ -> worker -> git -> engine -> Postgres), each with its
// expected verdict, findings and an intact audit chain.
describe('demo fixtures end to end', () => {
  let session: Session;
  let repositoryId: string;
  let shas: Record<string, string>;
  const runs = new Map<string, any>();

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

    const audit = (await session.client.get(`${base}/audit/verify`)).body;
    expect(audit).toMatchObject({ valid: true, chain: { valid: true }, seal: { valid: true }, findingsDigestValid: true, scoreValid: true });
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
