import { z } from 'zod';
import { config } from '../../config.js';
import type { PatchContextFile } from './patchProposalClient.js';

const PatchReviewSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES']),
  summary: z.string().min(1).max(1000),
  findings: z.array(z.object({
    id: z.string().min(1).max(160),
    severity: z.string().min(1).max(24),
    path: z.string().max(1024).nullable(),
    line: z.number().int().positive().nullable(),
    message: z.string().min(1).max(500),
    evidence: z.string().min(1).max(1000),
  }).strict()).max(100),
}).strict();

export type PatchReview = z.infer<typeof PatchReviewSchema>;

export interface PatchReviewReport {
  status: 'PASSED' | 'FAILED' | 'UNAVAILABLE' | 'NOT_RUN';
  reviewer: 'independent-llm' | null;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | null;
  summary: string;
  findings: PatchReview['findings'];
}

/** Requests an independent reviewer configured separately from patch generation. */
export async function reviewTaskPatch(input: {
  taskId: string;
  requirement: string;
  files: PatchContextFile[];
  summary: string;
  plan: string[];
  evidence: string[];
  unifiedDiff: string;
  signal?: AbortSignal;
}): Promise<PatchReviewReport> {
  const unavailable = (summary: string): PatchReviewReport => ({ status: 'UNAVAILABLE', reviewer: null, verdict: null, summary, findings: [] });
  if (!config.INTERNAL_SERVICE_TOKEN) return unavailable('Internal reviewer service is not configured.');
  if (input.signal?.aborted) return { ...unavailable('Independent review was cancelled.'), status: 'NOT_RUN' };

  let response: Response;
  try {
    response = await fetch(`${config.AI_SERVICE_URL.replace(/\/$/, '')}/api/v1/engineering/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.INTERNAL_SERVICE_TOKEN },
      body: JSON.stringify({
        task_id: input.taskId,
        requirement: input.requirement,
        files: input.files,
        summary: input.summary,
        plan: input.plan,
        evidence: input.evidence,
        unified_diff: input.unifiedDiff,
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(config.AI_SERVICE_TIMEOUT_MS)])
        : AbortSignal.timeout(config.AI_SERVICE_TIMEOUT_MS),
    });
  } catch (error) {
    if (input.signal?.aborted) return { ...unavailable('Independent review was cancelled.'), status: 'NOT_RUN' };
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return unavailable(timedOut ? 'Independent review request timed out.' : 'Independent review service is unavailable.');
  }
  if (!response.ok) return unavailable(response.status === 503
    ? 'Independent reviewer is not configured or unavailable.'
    : 'Independent reviewer did not return a successful response.');

  let body: unknown;
  try { body = await response.json(); }
  catch { return unavailable('Independent reviewer returned invalid JSON.'); }
  const parsed = PatchReviewSchema.safeParse(body);
  if (!parsed.success) return unavailable('Independent reviewer returned an invalid review.');

  const result = parsed.data;
  const status = result.verdict === 'APPROVE' && result.findings.length === 0 ? 'PASSED' : 'FAILED';
  return { status, reviewer: 'independent-llm', verdict: result.verdict, summary: result.summary, findings: result.findings };
}
