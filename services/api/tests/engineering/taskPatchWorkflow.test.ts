import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestPatchProposal, reviewTaskPatch } = vi.hoisted(() => ({ requestPatchProposal: vi.fn(), reviewTaskPatch: vi.fn() }));
vi.mock('../../src/services/engineering/patchProposalClient.js', () => ({ requestPatchProposal }));
vi.mock('../../src/services/engineering/patchReviewClient.js', () => ({ reviewTaskPatch }));

import { generateTaskPatch } from '../../src/services/engineering/taskPatchWorkflow.js';
import type { SandboxCommandRequest, SandboxCommandResult, SandboxDiagnostics, SandboxProvider } from '../../src/services/engineering/sandboxProvider.js';

describe('task patch workflow', () => {
  let root: string;
  let repository: string;
  let workspaces: string;
  let sourceFile: string;

  const proposal = (diff: string) => ({ summary: 'Change the value', plan: ['Update the value'], evidence: ['src/value.ts:1 contains the current value'], unified_diff: diff });
  const validDiff = [
    '--- a/src/value.ts',
    '+++ b/src/value.ts',
    '@@ -1 +1 @@',
    '-export const value = 1;',
    '+export const value = 2;',
  ].join('\n');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-patch-workflow-'));
    repository = path.join(root, 'repo');
    workspaces = path.join(root, 'task-workspaces');
    sourceFile = path.join(repository, 'src', 'value.ts');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, 'export const value = 1;\n');
    requestPatchProposal.mockReset();
    reviewTaskPatch.mockReset();
    reviewTaskPatch.mockResolvedValue({ status: 'UNAVAILABLE', reviewer: null, verdict: null, summary: 'Reviewer unavailable.', findings: [] });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (sandboxProvider?: SandboxProvider) => generateTaskPatch({
    taskId: 'task-1', workflowRunId: 'run-1', repositoryPath: repository, allowedRoots: root,
    workspaceRoot: workspaces, requirement: 'Change the value to two.', sandboxProvider,
    sandboxLimits: { timeoutMs: 10000, memoryMb: 512, cpuCount: 1, maxProcesses: 32, maxOutputBytes: 4096, network: 'disabled' },
  });

  it('applies the provider proposal only in the disposable workspace and cleans it', async () => {
    requestPatchProposal.mockResolvedValueOnce(proposal(validDiff));
    const result = await run();
    expect(result.changedFiles).toEqual(['src/value.ts']);
    expect(result.patchHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.contextFiles).toContain('src/value.ts');
    expect(result.workspaceCleanupStatus).toBe('CLEANED');
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe('export const value = 1;\n');
    expect(fs.readdirSync(workspaces)).toEqual([]);
  });

  it('allows one bounded repair request after patch validation fails', async () => {
    requestPatchProposal
      .mockResolvedValueOnce(proposal('--- a/../../outside.txt\n+++ b/../../outside.txt\n@@ -1 +1 @@\n-a\n+b'))
      .mockResolvedValueOnce(proposal(validDiff));
    const result = await run();
    expect(result.changedFiles).toEqual(['src/value.ts']);
    expect(requestPatchProposal).toHaveBeenCalledTimes(2);
    expect(requestPatchProposal.mock.calls[1]?.[0].repairFeedback).toContain('unsafe');
    expect(fs.readdirSync(workspaces)).toEqual([]);
  });

  it('cleans the task workspace when provider generation fails', async () => {
    requestPatchProposal.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(run()).rejects.toThrow('Patch proposal service is unavailable');
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe('export const value = 1;\n');
    expect(fs.readdirSync(workspaces)).toEqual([]);
  });

  it('runs scanner, test, and separate review stages before cleanup and returns actual results', async () => {
    fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const calls: SandboxCommandRequest[] = [];
    const sandbox: SandboxProvider = {
      available: true,
      async diagnose(): Promise<SandboxDiagnostics> {
        return { provider: 'docker', status: 'READY', image: 'asea/sandbox:test', reasonCode: null, message: 'ready' };
      },
      async execute(request): Promise<SandboxCommandResult> {
        calls.push(request);
        const command = request.command;
        const stdout = command.includes('version') ? 'scanner 1.0' : command[0] === 'gitleaks' && command[1] === 'dir'
          ? '[]' : command[0] === 'node' ? '1 test passed' : JSON.stringify({ results: [] });
        return { exitCode: 0, stdout, stderr: '', durationMs: 9, timedOut: false, cancelled: false, outputTruncated: false };
      },
    };
    requestPatchProposal.mockResolvedValueOnce(proposal(validDiff));
    reviewTaskPatch.mockResolvedValueOnce({ status: 'PASSED', reviewer: 'independent-llm', verdict: 'APPROVE', summary: 'No findings.', findings: [] });

    const result = await run(sandbox);
    expect(result.testReport.status).toBe('PASSED');
    expect(result.securityReport.status).toBe('PASSED');
    expect(result.reviewReport.status).toBe('PASSED');
    expect(calls.some((call) => call.command[0] === 'node')).toBe(true);
    expect(calls.filter((call) => call.workspaceReadOnly).length).toBe(6);
    expect(fs.readdirSync(workspaces)).toEqual([]);
  });
});
