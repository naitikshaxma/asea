import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  TaskSubmissionRequestSchema,
  type TaskResponse,
  type TaskListResponse,
} from '@autonomous-engineer/contracts';
import { AppError } from '../middlewares/errorHandler.js';

export const tasksRouter = Router();

// In-memory store for Phase 1 task tracking
const inMemoryTasks = new Map<string, TaskResponse>();

// Seed initial task to demonstrate dashboard state without fake claims
const initialTaskId = 'task-demo-01';
inMemoryTasks.set(initialTaskId, {
  id: initialTaskId,
  title: 'Repository Initialization & Architecture Verification',
  description: 'Verify service boundaries, contracts, and Docker Compose development environment.',
  taskType: 'BUG_INVESTIGATION',
  priority: 'NORMAL',
  status: 'COMPLETED',
  repositoryUrl: 'https://github.com/example/repo',
  targetBranch: 'main',
  createdAt: new Date(Date.now() - 3600000).toISOString(),
  updatedAt: new Date().toISOString(),
  executionMetadata: {
    workerId: 'worker-bootstrap',
    sandboxType: 'host-dev',
    phase: 'PHASE_1_BOOTSTRAP',
    note: 'Initial setup verification task successfully recorded.',
  },
});

tasksRouter.get('/tasks', (_req, res) => {
  const tasks = Array.from(inMemoryTasks.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const response: TaskListResponse = {
    tasks,
    total: tasks.length,
  };

  res.status(200).json(response);
});

tasksRouter.post('/tasks', (req, res, next) => {
  try {
    const validated = TaskSubmissionRequestSchema.parse(req.body);

    const now = new Date().toISOString();
    const taskId = `task-${randomUUID().slice(0, 8)}`;

    const newTask: TaskResponse = {
      id: taskId,
      title: validated.title,
      description: validated.description,
      taskType: validated.taskType,
      priority: validated.priority,
      status: 'PENDING',
      repositoryUrl: validated.repositoryUrl,
      targetBranch: validated.targetBranch,
      createdAt: now,
      updatedAt: now,
      executionMetadata: {
        workerId: 'worker-unassigned',
        sandboxType: 'disposable-container',
        phase: 'INTAKE_PHASE_1',
        note: 'Task accepted into intake queue. Automated agent execution pipeline is scheduled for Phase 2.',
      },
    };

    inMemoryTasks.set(taskId, newTask);

    res.status(201).json(newTask);
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/tasks/:id', (req, res, next) => {
  const task = inMemoryTasks.get(req.params.id);
  if (!task) {
    return next(new AppError(404, 'NOT_FOUND', `Task with ID ${req.params.id} not found`));
  }
  res.status(200).json(task);
});

tasksRouter.get('/system/info', (_req, res) => {
  res.status(200).json({
    platform: 'Autonomous AI Software Engineering Platform',
    version: '0.1.0',
    phase: 1,
    services: {
      api: { status: 'online', port: 4000 },
      agentService: { status: 'skeleton_ready', port: 8000 },
      workerBoundary: {
        status: 'documented',
        mode: 'isolated_sandboxes_planned',
        arbitraryShellExecutionEnabled: false,
      },
    },
    capabilities: [
      'Task Submission & Validation',
      'Contract-Driven System Architecture',
      'Health & Dependency Probing',
      'Docker Compose Infrastructure',
    ],
  });
});
