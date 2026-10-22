import type { ZodType, ZodTypeDef } from 'zod';
import {
  ScoreResultSchema,
  StaticAnalysisResultSchema,
  type ScoreRequest,
  type ScoreResult,
  type StaticAnalysisResult,
  type VerificationRequest,
} from '@autonomous-engineer/contracts';
import { config } from '../../config.js';

/** POSTs to the verification engine (services/agent-service) and validates the response. */
async function postToEngine<T>(
  path: string,
  body: unknown,
  schema: ZodType<T, ZodTypeDef, unknown>,
  what: string
): Promise<T> {
  if (!config.INTERNAL_SERVICE_TOKEN) {
    throw new Error('INTERNAL_SERVICE_TOKEN is not configured; cannot call the agent service');
  }

  const url = new URL(path, config.AI_SERVICE_URL);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.INTERNAL_SERVICE_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.AI_SERVICE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`Agent service returned ${res.status} for ${what}: ${text}`);
  }
  return schema.parse(await res.json());
}

/** Calls the verification engine's static-analysis node. */
export async function requestStaticAnalysis(request: VerificationRequest): Promise<StaticAnalysisResult> {
  return postToEngine('/api/v1/verify/static', request, StaticAnalysisResultSchema, 'static analysis');
}

/** Calls the engine's deterministic scoring node. */
export async function requestScore(request: ScoreRequest): Promise<ScoreResult> {
  return postToEngine('/api/v1/verify/score', request, ScoreResultSchema, 'scoring');
}
