import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { generateToken } from '../src/services/authService.js';
import * as queueService from '../src/services/queueService.js';
import { dispatchPendingOutboxEvents } from '../src/services/outboxDispatcher.js';

describe('Transactional Outbox, Queue & Task Cancellation', () => {
  const app = createApp();
  const testUser = { id: 'user-charlie', email: 'charlie@example.com' };
  const testToken = generateToken({ userId: testUser.id, email: testUser.email });
  const workspaceId = 'ws-charlie-01';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches pending outbox events to BullMQ and marks them DISPATCHED', async () => {
    const mockPendingEvent = {
      id: 'outbox-evt-01',
      aggregateType: 'Task',
      aggregateId: 'task-100',
      eventType: 'TASK_ENQUEUED',
      payload: {
        taskId: 'task-100',
        workspaceId,
        attemptNumber: 1,
        runId: 'run-100',
      },
      status: 'PENDING' as const,
      retryCount: 0,
      createdAt: new Date(),
      dispatchedAt: null,
    };

    vi.spyOn(prisma.outboxEvent, 'findMany').mockResolvedValueOnce([mockPendingEvent]);
    const enqueueSpy = vi.spyOn(queueService, 'enqueueTaskJob').mockResolvedValueOnce('job-task-100-run-100');
    const updateSpy = vi.spyOn(prisma.outboxEvent, 'update').mockResolvedValueOnce({
      ...mockPendingEvent,
      status: 'DISPATCHED',
      dispatchedAt: new Date(),
    });

    const dispatched = await dispatchPendingOutboxEvents();

    expect(dispatched).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith(mockPendingEvent.payload);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-evt-01' },
        data: expect.objectContaining({ status: 'DISPATCHED' }),
      })
    );
  });

  it('POST /api/v1/workspaces/:workspaceId/tasks/:taskId/cancel cancels QUEUED tasks', async () => {
    // Mock membership check
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce({
      id: 'mem-charlie',
      workspaceId,
      userId: testUser.id,
      role: 'MEMBER',
      createdAt: new Date(),
      workspace: { id: workspaceId, name: "Charlie's Workspace", ownerId: testUser.id },
    } as any);

    // Mock existing task
    const mockQueuedTask = {
      id: 'task-cancellable-01',
      workspaceId,
      status: 'QUEUED' as const,
      title: 'Task to cancel',
      description: 'Pending execution',
      taskType: 'BUG_INVESTIGATION' as const,
      priority: 'NORMAL' as const,
      runs: [{ id: 'run-cancellable-01', status: 'QUEUED' as const }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.task, 'findFirst').mockResolvedValueOnce(mockQueuedTask as any);
    vi.spyOn(prisma.task, 'update').mockResolvedValueOnce({
      ...mockQueuedTask,
      status: 'CANCELLED',
    } as any);
    vi.spyOn(prisma.workflowRun, 'update').mockResolvedValueOnce({
      id: 'run-cancellable-01',
      status: 'CANCELLED',
    } as any);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks/task-cancellable-01/cancel`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('CANCELLED');
  });

  it('POST /api/v1/workspaces/:workspaceId/tasks/:taskId/cancel rejects cancelling COMPLETED tasks', async () => {
    vi.spyOn(prisma.workspaceMembership, 'findUnique').mockResolvedValueOnce({
      id: 'mem-charlie',
      workspaceId,
      userId: testUser.id,
      role: 'MEMBER',
      createdAt: new Date(),
      workspace: { id: workspaceId, name: "Charlie's Workspace", ownerId: testUser.id },
    } as any);

    const mockCompletedTask = {
      id: 'task-finished-01',
      workspaceId,
      status: 'COMPLETED' as const,
      title: 'Completed Task',
      description: 'Finished',
      taskType: 'BUG_INVESTIGATION' as const,
      priority: 'NORMAL' as const,
      runs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.task, 'findFirst').mockResolvedValueOnce(mockCompletedTask as any);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/tasks/task-finished-01/cancel`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain("Cannot cancel task in 'COMPLETED' state");
  });
});
