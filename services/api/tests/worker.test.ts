import os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import { prisma } from '../src/services/prisma.js';
import { processTaskJob } from '../src/worker.js';
import type { TaskJobPayload } from '../src/services/queueService.js';

// An in-memory task and its runs that the stubbed Prisma calls read and mutate,
// so consecutive attempts see the state the previous attempt left behind.
describe('Task worker retries (B3), per-attempt runs and cancellation (B4)', () => {
  const taskId = 'task-w-01';
  const runId = 'run-w-01';
  const workspaceId = 'ws-w-01';

  let taskRow: Record<string, any>;
  let runs: Map<string, Record<string, any>>;
  let runRow: Record<string, any>; // the attempt-1 run created with the task
  let steps: Array<Record<string, any>>;
  let audits: Array<Record<string, any>>;
  let onStepCreated: (stepType: string) => void;

  function makeJob(attemptsMade: number, data: Partial<TaskJobPayload> = {}): Job<TaskJobPayload> {
    return {
      id: `job-${taskId}-${runId}`,
      attemptsMade,
      opts: { attempts: 3 },
      data: { taskId, runId, workspaceId, attemptNumber: 1, ...data },
    } as unknown as Job<TaskJobPayload>;
  }

  beforeEach(() => {
    taskRow = {
      id: taskId,
      workspaceId,
      creatorId: 'user-w-01',
      repositoryId: null,
      title: 'Worker test task',
      description: 'Exercise retry and cancellation paths.',
      taskType: 'BUG_INVESTIGATION',
      status: 'QUEUED',
      startedAt: null,
      completedAt: null,
      targetBranch: 'main',
    };
    runRow = { id: runId, taskId, attemptNumber: 1, status: 'QUEUED', errorSummary: null };
    runs = new Map([[runId, runRow]]);
    steps = [];
    audits = [];
    onStepCreated = () => {};

    const findTask = async () => ({ ...taskRow, runs: [...runs.values()].map((r) => ({ ...r })) });
    vi.spyOn(prisma.task, 'findUnique').mockImplementation(findTask as any);
    vi.spyOn(prisma.task, 'findUniqueOrThrow').mockImplementation(findTask as any);
    vi.spyOn(prisma.task, 'update').mockImplementation((async ({ data }: any) =>
      Object.assign(taskRow, data)) as any);
    vi.spyOn(prisma.workflowRun, 'findUnique').mockImplementation((async ({ where }: any) => {
      const run = runs.get(where.id);
      return run ? { ...run } : null;
    }) as any);
    vi.spyOn(prisma.workflowRun, 'findFirst').mockImplementation((async ({ where }: any) => {
      const run = [...runs.values()].find(
        (r) => r.taskId === where.taskId && r.attemptNumber === where.attemptNumber
      );
      return run ? { ...run } : null;
    }) as any);
    vi.spyOn(prisma.workflowRun, 'create').mockImplementation((async ({ data }: any) => {
      const run = { id: `run-w-attempt-${data.attemptNumber}`, errorSummary: null, ...data };
      runs.set(run.id, run);
      return { ...run };
    }) as any);
    vi.spyOn(prisma.workflowRun, 'update').mockImplementation((async ({ where, data }: any) =>
      Object.assign(runs.get(where.id)!, data)) as any);
    vi.spyOn(prisma.workflowStep, 'create').mockImplementation((async ({ data }: any) => {
      steps.push(data);
      onStepCreated(data.stepType);
      return data;
    }) as any);
    vi.spyOn(prisma.auditEvent, 'create').mockImplementation((async ({ data }: any) => {
      audits.push(data);
      return data;
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the task RUNNING after a failed non-final attempt, then reports the unavailable workflow', async () => {
    await expect(processTaskJob(makeJob(0, { simulatedFailure: true }))).rejects.toThrow(
      'Simulated worker fault'
    );

    // The attempt's own run records the failure; the task is not terminal
    expect(taskRow.status).toBe('RUNNING');
    expect(runRow.status).toBe('FAILED');
    expect(runRow.errorSummary).toBe('Simulated worker fault for test verification');
    expect(audits).toHaveLength(0);

    // BullMQ retries the failed attempt; unsupported work is reported honestly.
    await processTaskJob(makeJob(1));

    const retryRun = [...runs.values()].find((r) => r.attemptNumber === 2)!;
    expect(runs.size).toBe(2);
    expect(retryRun.status).toBe('COMPLETED');
    expect(runRow.status).toBe('FAILED');
    expect(taskRow.status).toBe('NEEDS_ATTENTION');
    expect(taskRow.failureCode).toBe('WORKFLOW_UNAVAILABLE');
    expect(audits.map((a) => a.eventType)).toEqual(['TASK_NEEDS_ATTENTION']);

    // Steps attach to their own attempt's run
    const stepsByRun = (id: string) => steps.filter((s) => s.workflowRunId === id).map((s) => s.stepType);
    expect(stepsByRun(runId)).toEqual(['VALIDATE_CONTEXT']);
    expect(stepsByRun(retryRun.id)).toEqual(['VALIDATE_CONTEXT', 'GENERATE_SPEC']);
    expect(steps.find((s) => s.workflowRunId === retryRun.id && s.stepType === 'GENERATE_SPEC')?.stepStatus).toBe('SKIPPED');
  });

  it('reuses the attempt run when a stalled job is re-run without a new attempt number', async () => {
    taskRow.status = 'RUNNING';
    runRow.status = 'FAILED';
    runs.set('run-w-2', { id: 'run-w-2', taskId, attemptNumber: 2, status: 'RUNNING', errorSummary: null });

    await processTaskJob(makeJob(1));

    expect(prisma.workflowRun.create).not.toHaveBeenCalled();
    expect(runs.get('run-w-2')!.status).toBe('COMPLETED');
    expect(steps.every((s) => s.workflowRunId === 'run-w-2')).toBe(true);
  });

  it('records the worker identity and leaves unsupported work unavailable instead of claiming completion', async () => {
    await processTaskJob(makeJob(0));

    expect(runRow.workerId).toBe(`${os.hostname()}:${process.pid}`);
    const metadata = JSON.stringify(steps.map((s) => s.resultMetadata));
    expect(metadata).toMatch(/UNAVAILABLE/);
    expect(metadata).toMatch(/NOT_GENERATED/);
    expect(taskRow.status).toBe('NEEDS_ATTENTION');
    expect(audits[0].eventType).toBe('TASK_NEEDS_ATTENTION');
  });

  it('does not reopen a task whose committed patch result is redelivered after the worker acknowledgement gap', async () => {
    taskRow.status = 'NEEDS_ATTENTION';

    await processTaskJob(makeJob(0));

    expect(steps).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    expect(taskRow.status).toBe('NEEDS_ATTENTION');
    expect(runRow.status).toBe('QUEUED');
  });

  it('marks the task FAILED only on the final attempt, in a run for that attempt', async () => {
    taskRow.status = 'RUNNING';
    runRow.status = 'FAILED';

    await expect(processTaskJob(makeJob(2, { simulatedFailure: true }))).rejects.toThrow(
      'Simulated worker fault'
    );

    const finalRun = [...runs.values()].find((r) => r.attemptNumber === 3)!;
    expect(finalRun.status).toBe('FAILED');
    expect(taskRow.status).toBe('FAILED');
    expect(taskRow.failureReason).toBe('Simulated worker fault for test verification');
    expect(audits.map((a) => a.eventType)).toEqual(['TASK_FAILED']);
    expect(audits[0].metadata.runId).toBe(finalRun.id);
  });

  it('stops between steps and cancels through the state machine when CANCEL_REQUESTED', async () => {
    // The user requests cancellation while the first step is running
    onStepCreated = (stepType) => {
      if (stepType === 'VALIDATE_CONTEXT') taskRow.status = 'CANCEL_REQUESTED';
    };

    await processTaskJob(makeJob(0));

    expect(steps.map((s) => s.stepType)).toEqual(['VALIDATE_CONTEXT']);
    expect(taskRow.status).toBe('CANCELLED');
    expect(runRow.status).toBe('CANCELLED');
    expect(runRow.errorSummary).toBe('Task cancelled by user after VALIDATE_CONTEXT.');
    expect(audits).toHaveLength(0);
  });

  it('cancels instead of completing when cancellation arrives during the last step', async () => {
    onStepCreated = (stepType) => {
      if (stepType === 'GENERATE_SPEC') taskRow.status = 'CANCEL_REQUESTED';
    };

    await processTaskJob(makeJob(0));

    expect(steps).toHaveLength(2);
    expect(taskRow.status).toBe('CANCELLED');
    expect(runRow.status).toBe('CANCELLED');
    expect(audits).toHaveLength(0);
  });

  it('honours a cancellation requested during a failed attempt instead of retrying', async () => {
    onStepCreated = () => {
      taskRow.status = 'CANCEL_REQUESTED';
    };
    // The post-step check still sees RUNNING, so the request lands just before
    // the simulated fault; without honouring it the job would be retried.
    vi.spyOn(prisma.task, 'findUniqueOrThrow')
      .mockImplementationOnce((async () => ({ ...taskRow, status: 'RUNNING' })) as any)
      .mockImplementation((async () => ({ ...taskRow })) as any);

    await expect(processTaskJob(makeJob(0, { simulatedFailure: true }))).resolves.toBeUndefined();

    expect(taskRow.status).toBe('CANCELLED');
    expect(runRow.status).toBe('CANCELLED');
    expect(runRow.errorSummary).toBe('Task cancelled by user after a failed attempt.');
  });

  it('cancels a retry picked up in CANCEL_REQUESTED without creating a run for it', async () => {
    taskRow.status = 'CANCEL_REQUESTED';
    runRow.status = 'FAILED';

    await processTaskJob(makeJob(1));

    expect(steps).toHaveLength(0);
    expect(prisma.workflowRun.create).not.toHaveBeenCalled();
    expect(taskRow.status).toBe('CANCELLED');
    expect(runRow.status).toBe('FAILED'); // the earlier attempt's outcome is kept
  });

  it('does not report a CODE_PATCH task as complete before a patch provider and sandbox are configured', async () => {
    taskRow.taskType = 'CODE_PATCH';
    await processTaskJob(makeJob(0));

    expect(taskRow.status).toBe('NEEDS_ATTENTION');
    expect(taskRow.failureCode).toBe('WORKFLOW_UNAVAILABLE');
    expect(runRow.status).toBe('COMPLETED');
    expect(JSON.stringify(steps)).not.toMatch(/unified_diff|patchHash|passed/);
    expect(audits[0].eventType).toBe('TASK_NEEDS_ATTENTION');
  });
});
