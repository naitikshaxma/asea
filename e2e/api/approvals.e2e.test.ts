import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { psql, registerUser } from '../support/api.js';

describe('patch approval persistence through PostgreSQL and Redis-backed API', () => {
  it('requires a second workspace admin, records the decision, and exposes audit history', async () => {
    const requester = await registerUser('approval-requester');
    const reviewer = await registerUser('approval-reviewer');
    // A GitHub-provider repository makes the worker stop in NEEDS_ATTENTION
    // without generating a patch, so the seeded artifact below is the only one.
    const repository = await requester.client.post(`/api/v1/workspaces/${requester.workspaceId}/repositories`, {
      name: 'approval-e2e', provider: 'GITHUB', repositoryUrl: 'https://github.com/example/approval-e2e', defaultBranch: 'main',
    });
    expect(repository.status).toBe(201);
    const taskResponse = await requester.client.post(`/api/v1/workspaces/${requester.workspaceId}/tasks`, {
      title: 'Approval E2E proposal',
      description: 'Exercise the persisted approval decision path.',
      taskType: 'CODE_PATCH',
      repositoryId: repository.body.id,
    });
    expect(taskResponse.status).toBe(201);

    const deadline = Date.now() + 30_000;
    let task: any;
    while (Date.now() < deadline) {
      const response = await requester.client.get(`/api/v1/workspaces/${requester.workspaceId}/tasks/${taskResponse.body.id}`);
      task = response.body;
      if (task.status === 'NEEDS_ATTENTION') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(task.status).toBe('NEEDS_ATTENTION');

    // Seed a verified patch artifact to exercise approval persistence/API behavior
    // (approval requires passing gates). This E2E does not claim the worker generated it.
    const patchHash = 'c'.repeat(64);
    psql(`UPDATE "Task" SET "executionMetadata" = COALESCE("executionMetadata", '{}'::jsonb) || '{"patchHash":"${patchHash}"}'::jsonb WHERE id = '${taskResponse.body.id}'`);
    psql(`INSERT INTO "TaskPatch" ("id", "taskId", "workflowRunId", "snapshotHash", "patchHash", "summary", "plan", "contextFiles", "changedFiles", "unifiedDiff", "testStatus", "securityStatus", "reviewStatus", "workspaceCleanupStatus", "status", "updatedAt") VALUES ('${randomUUID()}', '${taskResponse.body.id}', '${task.runs[0].id}', '${'b'.repeat(64)}', '${patchHash}', 'E2E seeded proposal', '["review seeded diff"]'::jsonb, '["src/app.ts"]'::jsonb, '["src/app.ts"]'::jsonb, '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n', 'PASSED', 'PASSED', 'PASSED', 'CLEANED', 'PROPOSED', CURRENT_TIMESTAMP)`);
    psql(`INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role") VALUES ('${randomUUID()}', '${requester.workspaceId}', '${reviewer.user.id}', 'ADMIN')`);

    const base = `/api/v1/workspaces/${requester.workspaceId}`;
    const created = await requester.client.post(`${base}/tasks/${taskResponse.body.id}/approvals`, { patchHash });
    expect(created.status).toBe(201);
    expect((await requester.client.post(`${base}/approvals/${created.body.id}/decision`, { decision: 'APPROVED' })).status).toBe(403);

    const decision = await reviewer.client.post(`${base}/approvals/${created.body.id}/decision`, { decision: 'APPROVED' });
    expect(decision.status).toBe(200);
    expect(decision.body).toMatchObject({ status: 'APPROVED', decidedById: reviewer.user.id, patchHash });

    const detail = await requester.client.get(`${base}/approvals/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.patchIsCurrent).toBe(true);
    expect(detail.body.auditHistory.map((event: { eventType: string }) => event.eventType)).toEqual([
      'PATCH_APPROVAL_REQUESTED', 'PATCH_APPROVED',
    ]);
    const patch = await requester.client.get(`${base}/tasks/${taskResponse.body.id}/patch`);
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ patchHash, status: 'APPROVED', testStatus: 'PASSED' });
  });
});
