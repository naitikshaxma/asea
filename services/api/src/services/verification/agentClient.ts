import type { z, ZodType, ZodTypeDef } from 'zod';
import {
  IndexResponseSchema,
  IndexStatusSchema,
  PipelineEventSchema,
  ScoreResultSchema,
  type IndexRequest,
  type IndexResponse,
  type IndexStatus,
  type PipelineEvent,
  type PipelineRequest,
  type PipelineResult,
  type ScoreRequestSchema,
  type ScoreResult,
} from '@autonomous-engineer/contracts';
import { config } from '../../config.js';

// Client for the verification engine (services/agent-service). Every call sends
// the shared X-Internal-Token and is bounded by AI_SERVICE_TIMEOUT_MS.

async function engineFetch(path: string, init: RequestInit, what: string): Promise<Response> {
  if (!config.INTERNAL_SERVICE_TOKEN) {
    throw new Error('INTERNAL_SERVICE_TOKEN is not configured; cannot call the agent service');
  }
  const res = await fetch(new URL(path, config.AI_SERVICE_URL), {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.INTERNAL_SERVICE_TOKEN, ...init.headers },
    signal: AbortSignal.timeout(config.AI_SERVICE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`Agent service returned ${res.status} for ${what}: ${text}`);
  }
  return res;
}

async function engineJson<T>(path: string, init: RequestInit, schema: ZodType<T, ZodTypeDef, unknown>, what: string): Promise<T> {
  const res = await engineFetch(path, init, what);
  return schema.parse(await res.json());
}

/** Deterministic score of findings under a policy (the engine's scoring node). */
export async function requestScore(request: z.input<typeof ScoreRequestSchema>): Promise<ScoreResult> {
  return engineJson('/api/v1/verify/score', { method: 'POST', body: JSON.stringify(request) }, ScoreResultSchema, 'scoring');
}

/** Whether the engine has indexed the repository at this commit. */
export async function getIndexStatus(repositoryId: string, commitSha: string): Promise<IndexStatus> {
  const path = `/api/v1/index/${encodeURIComponent(repositoryId)}/${encodeURIComponent(commitSha)}`;
  return engineJson(path, { method: 'GET' }, IndexStatusSchema, 'index status');
}

/** Sends one batch of a commit's files to the engine's repository index. */
export async function indexFiles(request: IndexRequest): Promise<IndexResponse> {
  return engineJson('/api/v1/index', { method: 'POST', body: JSON.stringify(request) }, IndexResponseSchema, 'indexing');
}

/**
 * Runs the engine's verification pipeline, streaming its progress: `onEvent`
 * receives each agent_started / agent_finished event as it happens (and is
 * awaited before the next is read). Resolves with the result; rejects on an
 * error event or a stream that ends without a result.
 */
export async function runPipeline(
  request: PipelineRequest,
  onEvent: (event: Exclude<PipelineEvent, { type: 'result' | 'error' }>) => Promise<void> | void
): Promise<PipelineResult> {
  const res = await engineFetch(
    '/api/v1/verify',
    { method: 'POST', body: JSON.stringify(request), headers: { Accept: 'application/x-ndjson' } },
    'the verification pipeline'
  );
  if (!res.body) throw new Error('Agent service returned no body for the verification pipeline');

  const decoder = new TextDecoder();
  let buffered = '';
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const event = PipelineEventSchema.parse(JSON.parse(line));
      if (event.type === 'result') {
        await reader.cancel();
        return event.result;
      }
      if (event.type === 'error') {
        await reader.cancel();
        throw new Error(`Verification pipeline failed (${event.code}): ${event.message}`);
      }
      await onEvent(event);
    }
    if (done) break;
  }
  throw new Error('Verification pipeline stream ended without a result');
}
