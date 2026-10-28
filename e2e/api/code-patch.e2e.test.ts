import { describe, expect, it } from 'vitest';
import { addDemoRepository, registerUser, type Session } from '../support/api.js';

describe('provider-backed code patch task through the disposable E2E stack', () => {
  it('stores a fake-provider patch and blocks approval when sandbox and reviewer are unavailable', async () => {
    const session: Session = await registerUser('code-patch');
    const repositoryId = await addDemoRepository(session, 'demo_app (patch workflow)');
    const submitted = await session.client.post(`/api/v1/workspaces/${session.workspaceId}/tasks`, {
      title: 'Add the deterministic patch marker',
      description: 'Propose a small safe change to the registered demo repository.',
      taskType: 'CODE_PATCH',
      priority: 'NORMAL',
      repositoryId,
      targetBranch: 'main',
    });
    expect(submitted.status).toBe(201);

    let task: any;
    for (let attempt = 0; attempt < 120; attempt++) {
      const detail = await session.client.get(`/api/v1/workspaces/${session.workspaceId}/tasks/${submitted.body.id}`);
      expect(detail.status).toBe(200);
      task = detail.body;
      if (['NEEDS_ATTENTION', 'FAILED', 'CANCELLED'].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(task.status).toBe('NEEDS_ATTENTION');
    expect(task.executionMetadata).toMatchObject({ patchStatus: 'PROPOSED', status: 'PATCH_BLOCKED', testStatus: 'NOT_RUN', securityStatus: 'UNAVAILABLE', reviewStatus: 'UNAVAILABLE' });
    expect(task.executionMetadata.patchHash).toMatch(/^[a-f0-9]{64}$/);

    const base = `/api/v1/workspaces/${session.workspaceId}`;
    const patch = await session.client.get(`${base}/tasks/${task.id}/patch`);
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({
      patchHash: task.executionMetadata.patchHash,
      status: 'PROPOSED',
      testStatus: 'NOT_RUN',
      securityStatus: 'UNAVAILABLE',
      reviewStatus: 'UNAVAILABLE',
      workspaceCleanupStatus: 'CLEANED',
    });
    expect(patch.body.unifiedDiff).toContain('ASEA deterministic test proposal');
    expect(patch.body.changedFiles.length).toBeGreaterThan(0);

    const approvals = await session.client.get(`${base}/approvals?status=PENDING`);
    expect(approvals.status).toBe(200);
    expect(approvals.body.approvals).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: task.id, patchHash: patch.body.patchHash, status: 'PENDING' }),
    ]));
    // Requesting approval by hand does not bypass the blocked verification gates
    const forced = await session.client.post(`${base}/tasks/${task.id}/approvals`, { patchHash: patch.body.patchHash });
    expect(forced.status).toBe(409);

    const stepSummary = task.runs[0].steps.map((step: any) => `${step.stepType}:${step.stepStatus}`);
    expect(stepSummary).toEqual(expect.arrayContaining(['APPLY_PATCH:COMPLETED', 'EXECUTE_TESTS:SKIPPED', 'STATIC_ANALYSIS:SKIPPED', 'INDEPENDENT_REVIEW:SKIPPED', 'REQUEST_APPROVAL:SKIPPED']));
  }, 120_000);

  it('rejects task types without a workflow before anything is persisted', async () => {
    const session: Session = await registerUser('unsupported-type');
    const repositoryId = await addDemoRepository(session, 'demo_app (unsupported type)');
    const base = `/api/v1/workspaces/${session.workspaceId}`;
    const rejected = await session.client.post(`${base}/tasks`, {
      title: 'Investigate a bug', description: 'This task type has no worker workflow yet.',
      taskType: 'BUG_INVESTIGATION', priority: 'NORMAL', repositoryId,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');

    const listed = await session.client.get(`${base}/tasks`);
    expect(listed.status).toBe(200);
    expect(listed.body.tasks).toEqual([]);
  });
});
