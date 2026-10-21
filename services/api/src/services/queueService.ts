import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const TASK_QUEUE_NAME = 'task-execution';

export interface TaskJobPayload {
  taskId: string;
  workspaceId: string;
  attemptNumber: number;
  runId: string;
  simulatedFailure?: boolean;
}

let queueRedisConnection: Redis | null = null;
let taskQueue: Queue<TaskJobPayload> | null = null;

function getRedisConnection(): Redis {
  if (!queueRedisConnection) {
    const opts = {
      maxRetriesPerRequest: null, // Required by BullMQ
      lazyConnect: true,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
    };

    if (config.REDIS_URL) {
      queueRedisConnection = new Redis(config.REDIS_URL, opts);
    } else {
      queueRedisConnection = new Redis({
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        ...opts,
      });
    }

    queueRedisConnection.on('error', (err) => {
      logger.warn('Queue Redis connection error', { error: err.message });
    });
  }

  return queueRedisConnection;
}

export function getTaskQueue(): Queue<TaskJobPayload> {
  if (!taskQueue) {
    taskQueue = new Queue<TaskJobPayload>(TASK_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          age: 3600, // Keep 1 hour
          count: 1000,
        },
        removeOnFail: {
          age: 86400, // Keep 24 hours
        },
      },
    });
  }

  return taskQueue;
}

export async function enqueueTaskJob(
  payload: TaskJobPayload,
  options?: JobsOptions
): Promise<string> {
  const queue = getTaskQueue();
  const job = await queue.add(`task-${payload.taskId}`, payload, {
    jobId: `job-${payload.taskId}-${payload.runId}`,
    ...options,
  });

  logger.info('Enqueued task execution job', {
    taskId: payload.taskId,
    runId: payload.runId,
    jobId: job.id,
  });

  return job.id ?? `job-${payload.taskId}`;
}

export async function getQueueHealth(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  status: 'connected' | 'disconnected';
}> {
  try {
    const queue = getTaskQueue();
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      status: 'connected',
    };
  } catch (err: unknown) {
    return {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      status: 'disconnected',
    };
  }
}

export async function closeTaskQueue(): Promise<void> {
  if (taskQueue) {
    await taskQueue.close();
    taskQueue = null;
  }
  if (queueRedisConnection) {
    queueRedisConnection.disconnect();
    queueRedisConnection = null;
  }
}
