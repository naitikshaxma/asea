import { prisma } from './prisma.js';
import { enqueueTaskJob, type TaskJobPayload } from './queueService.js';
import { logger } from '../logger.js';

let pollingInterval: NodeJS.Timeout | null = null;
let isDispatching = false;

export async function dispatchPendingOutboxEvents(): Promise<number> {
  if (isDispatching) return 0;
  isDispatching = true;

  let dispatchedCount = 0;
  try {
    const pendingEvents = await prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    for (const event of pendingEvents) {
      try {
        const payload = event.payload as unknown as TaskJobPayload;
        await enqueueTaskJob(payload);

        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: 'DISPATCHED',
            dispatchedAt: new Date(),
          },
        });

        dispatchedCount++;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const nextRetry = event.retryCount + 1;
        const nextStatus = nextRetry >= 5 ? 'FAILED' : 'PENDING';

        logger.warn('Failed to dispatch outbox event to queue', {
          eventId: event.id,
          retryCount: nextRetry,
          error: errorMsg,
        });

        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            retryCount: nextRetry,
            status: nextStatus,
          },
        });
      }
    }
  } catch (err: unknown) {
    // If DB is offline or querying fails, log without crashing
    logger.debug('Outbox dispatch query skipped or failed', { error: String(err) });
  } finally {
    isDispatching = false;
  }

  return dispatchedCount;
}

export function startOutboxDispatcher(intervalMs = 3000): void {
  if (pollingInterval) return;

  // Immediate initial check
  dispatchPendingOutboxEvents().catch(() => {});

  pollingInterval = setInterval(() => {
    dispatchPendingOutboxEvents().catch(() => {});
  }, intervalMs);

  logger.info('Transactional outbox dispatcher started', { intervalMs });
}

export function stopOutboxDispatcher(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    logger.info('Transactional outbox dispatcher stopped');
  }
}
