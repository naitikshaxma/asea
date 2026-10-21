import os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import { prisma } from '../src/services/prisma.js';
import { processTaskJob } from '../src/worker.js';
import type { TaskJobPayload } from '../src/services/queueService.js';

// An in-memory task and run that the stubbed Prisma calls read and mutate, so
// consecutive attempts see the state the previous attempt left behind.
describe('Task worker retries (B3) and cancellation (B4)', () => {
  const taskId = 'task-w-01';
  const runId = 'run-w-01';
  const workspaceId = 'ws-w-01';

  let taskRow: Record<string, any>;
  let runRow: Record<string, any>;
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
    steps = [];
    audits = [];
    onStepCreated = () => {};

    const findTask = async () => ({ ...taskRow, runs: [{ ...runRow }] });
    vi.spyOn(prisma.task, 'findUnique').mockImplementation(findTask as any);
    vi.spyOn(prisma.task, 'findUniqueOrThrow').mockImplementation(findTask as any);
    vi.spyOn(prisma.task, 'update').mockImplementation((async ({ data }: any) =>
      Object.assign(taskRow, data)) as any);
    vi.spyOn(prisma.workflowRun, 'findUnique').mockImplementation((async () => ({ ...runRow })) as any);
    vi.spyOn(prisma.workflowRun, 'update').mockImplementation((async ({ data }: any) =>
      Object.assign(runRow, data)) as any);
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

  it('keeps the task RUNNING after a failed non-final attempt, and the retry completes it', async () => {
    await expect(processTaskJob(makeJob(0, { simulatedFailure: true }))).rejects.toThrow(
      'Simulated worker fault'
    );

    expect(taskRow.status).toBe('RUNNING');
    expect(runRow.status).toBe('RUNNING');
    expect(runRow.errorSummary).toMatch(/^Attempt 1 of 3 failed: Simulated worker fault/);
    expect(audits).toHaveLength(0);

    // BullMQ retries with the same job data; this time the work succeeds
    await processTaskJob(makeJob(1));

    expect(taskRow.status).toBe('COMPLETED');
    expect(runRow.status).toBe('COMPLETED');
    expect(audits.map((a) => a.eventType)).toEqual(['TASK_COMPLETED']);
  });

  it('records the real worker identity and no fabricated verification results', async () => {
    await processTaskJob(makeJob(0));

    expect(runRow.workerId).toBe(`${os.hostname()}:${process.pid}`);
    const metadata = JSON.stringify(steps.map((s) => s.resultMetadata));
    expect(metadata).not.toMatch(/auditPass|verified_safe|worker-bullmq-01/);
    const boundaries = steps.find((s) => s.stepType === 'VERIFY_BOUNDARIES');
    expect(boundaries?.resultMetadata.note).toMatch(/no boundary verification is implemented/);
  });

  it('marks the task and run FAILED only on the final attempt', async () => {
    taskRow.status = 'RUNNING';
    runRow.status = 'RUNNING';

    await expect(processTaskJob(makeJob(2, { simulatedFailure: true }))).rejects.toThrow(
      'Simulated worker fault'
    );

    expect(taskRow.status).toBe('FAILED');
    expect(taskRow.failureReason).toBe('Simulated worker fault for test verification');
    expect(runRow.status).toBe('FAILED');
    expect(audits.map((a) => a.eventType)).toEqual(['TASK_FAILED']);
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
      if (stepType === 'VERIFY_BOUNDARIES') taskRow.status = 'CANCEL_REQUESTED';
    };

    await processTaskJob(makeJob(0));

    expect(steps).toHaveLength(4);
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

  it('cancels a task picked up in CANCEL_REQUESTED after an earlier attempt left the run RUNNING', async () => {
    taskRow.status = 'CANCEL_REQUESTED';
    runRow.status = 'RUNNING';

    await processTaskJob(makeJob(1));

    expect(steps).toHaveLength(0);
    expect(taskRow.status).toBe('CANCELLED');
    expect(runRow.status).toBe('CANCELLED');
  });
});
