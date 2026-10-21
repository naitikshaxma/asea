import {
  StaticAnalysisResultSchema,
  type StaticAnalysisResult,
  type VerificationRequest,
} from '@autonomous-engineer/contracts';
import { config } from '../../config.js';

/** Calls the verification engine's static-analysis node (services/agent-service). */
export async function requestStaticAnalysis(request: VerificationRequest): Promise<StaticAnalysisResult> {
  if (!config.INTERNAL_SERVICE_TOKEN) {
    throw new Error('INTERNAL_SERVICE_TOKEN is not configured; cannot call the agent service');
  }

  const url = new URL('/api/v1/verify/static', config.AI_SERVICE_URL);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.INTERNAL_SERVICE_TOKEN },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(config.AI_SERVICE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`Agent service returned ${res.status} for static analysis: ${body}`);
  }
  return StaticAnalysisResultSchema.parse(await res.json());
}
