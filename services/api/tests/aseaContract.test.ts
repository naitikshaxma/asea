import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ChangedFileSchema,
  DEFAULT_POLICY_CONFIG,
  FindingSchema,
  PolicyConfigSchema,
  ScoreRequestSchema,
  ScoreResultSchema,
  StaticAnalysisResultSchema,
  VerificationRequestSchema,
} from '@autonomous-engineer/contracts';

// The committed JSON Schema is the bridge to the Pydantic models: this test pins
// it to the Zod schemas, and services/agent-service/tests/test_contract_sync.py
// compares it with Pydantic. After changing the Zod contract, regenerate with:
//   cd services/api && npx vitest run tests/aseaContract.test.ts -u
const SCHEMA_FILE = '../../../packages/contracts/schemas/asea-contract.schema.json';
// The default policy, read by the Python tests so both sides score with the same document
const DEFAULT_POLICY_FILE = '../../../packages/contracts/schemas/default-policy.json';

describe('ASEA verification contract (Zod side)', () => {
  it('matches the committed JSON Schema shared with the Pydantic models', async () => {
    const toJson = (schema: Parameters<typeof zodToJsonSchema>[0]) =>
      zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' });

    const schemas = {
      ChangedFile: toJson(ChangedFileSchema),
      VerificationRequest: toJson(VerificationRequestSchema),
      Finding: toJson(FindingSchema),
      StaticAnalysisResult: toJson(StaticAnalysisResultSchema),
      PolicyConfig: toJson(PolicyConfigSchema),
      ScoreRequest: toJson(ScoreRequestSchema),
      ScoreResult: toJson(ScoreResultSchema),
    };

    await expect(`${JSON.stringify(schemas, null, 2)}\n`).toMatchFileSnapshot(SCHEMA_FILE);
  });

  it('pins the default policy shared with the Python tests', async () => {
    expect(PolicyConfigSchema.parse(DEFAULT_POLICY_CONFIG)).toEqual(DEFAULT_POLICY_CONFIG);
    await expect(`${JSON.stringify(DEFAULT_POLICY_CONFIG, null, 2)}\n`).toMatchFileSnapshot(DEFAULT_POLICY_FILE);
  });

  it('rejects policies whose bands or caps are inconsistent', () => {
    const bands = (b: Partial<typeof DEFAULT_POLICY_CONFIG.verdict_bands>) => ({
      ...DEFAULT_POLICY_CONFIG,
      verdict_bands: { ...DEFAULT_POLICY_CONFIG.verdict_bands, ...b },
    });
    expect(() => PolicyConfigSchema.parse(bands({ block: 5 }))).toThrow(/Must be 0/);
    expect(() => PolicyConfigSchema.parse(bands({ review: 95 }))).toThrow(/must decrease/);
    const cap = DEFAULT_POLICY_CONFIG.caps[0]!;
    expect(() => PolicyConfigSchema.parse({ ...DEFAULT_POLICY_CONFIG, caps: [cap, cap] })).toThrow(/unique/);
    expect(() =>
      PolicyConfigSchema.parse({
        ...DEFAULT_POLICY_CONFIG,
        severity_weights: { ...DEFAULT_POLICY_CONFIG.severity_weights, low: 1.23456 },
      })
    ).toThrow(/4 decimal/);
  });

  it('accepts a valid request and result and rejects out-of-contract values', () => {
    const request = {
      repository_id: 'repo-1',
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      requirement: 'Add an authenticated endpoint',
      unified_diff: '',
      changed_files: [{ path: 'app/routes.py', head_content: 'print(1)\n' }],
      author_type: 'ai',
    };
    expect(VerificationRequestSchema.parse(request)).toEqual(request);
    expect(() => VerificationRequestSchema.parse({ ...request, author_type: 'bot' })).toThrow();

    const finding = {
      id: 'f-1',
      category: 'static',
      severity: 'high',
      title: 'eval() call',
      file: 'app/routes.py',
      line: 3,
      evidence: ['eval(user_input)'],
      source: 'deterministic',
      rule_id: 'ASEA-PY-EVAL',
      remediation: 'Avoid eval.',
    };
    expect(
      StaticAnalysisResultSchema.parse({ findings: [finding], tools_run: ['python-ast'], tools_unavailable: [], duration_ms: 4, semgrep_ruleset_sha256: null })
    ).toBeTruthy();
    expect(() => FindingSchema.parse({ ...finding, line: 0 })).toThrow();
    expect(() => FindingSchema.parse({ ...finding, category: 'style' })).toThrow();
  });
});
