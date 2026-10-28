import { z } from 'zod';
import { config } from '../../config.js';

const PatchProposalSchema = z.object({
  summary: z.string().min(1).max(1000),
  plan: z.array(z.string().min(1).max(2000)).min(1).max(12),
  evidence: z.array(z.string().min(1).max(2000)).min(1).max(24),
  unified_diff: z.string().min(1).max(2_000_000),
}).strict();

export type PatchProposal = z.infer<typeof PatchProposalSchema>;
export interface PatchContextFile { path: string; content: string }

export class PatchProposalError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'PatchProposalError';
  }
}

/** Calls the internal model boundary without logging repository contents or provider response bodies. */
export async function requestPatchProposal(input: {
  taskId: string;
  requirement: string;
  files: PatchContextFile[];
  repairFeedback?: string;
  signal?: AbortSignal;
}): Promise<PatchProposal> {
  if (!config.INTERNAL_SERVICE_TOKEN) throw new PatchProposalError('Internal agent service is not configured');

  let response: Response;
  try {
    response = await fetch(`${config.AI_SERVICE_URL.replace(/\/$/, '')}/api/v1/engineering/propose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': config.INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify({
        task_id: input.taskId,
        requirement: input.requirement,
        files: input.files,
        ...(input.repairFeedback ? { repair_feedback: input.repairFeedback } : {}),
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(config.AI_SERVICE_TIMEOUT_MS)])
        : AbortSignal.timeout(config.AI_SERVICE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    throw new PatchProposalError(timedOut ? 'Patch proposal request timed out' : 'Patch proposal service is unavailable', true);
  }

  if (!response.ok) {
    if (response.status === 503) throw new PatchProposalError('Patch generation provider is unavailable');
    if (response.status >= 500) throw new PatchProposalError('Patch proposal service failed', true);
    throw new PatchProposalError(`Patch proposal request was rejected (${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PatchProposalError('Patch proposal service returned invalid JSON', true);
  }
  const parsed = PatchProposalSchema.safeParse(body);
  if (!parsed.success) throw new PatchProposalError('Patch proposal service returned an invalid proposal');
  return parsed.data;
}
