import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GithubApiError, type GithubAppClient, type GithubPullRequest } from '../../src/services/github/githubAppClient.js';
import { diagnoseCiChecks, publishApprovedPatch, summarizeCiChecks } from '../../src/services/github/publishPatch.js';

const original = 'export const value = 1;\n';
const diff = [
  'diff --git a/src/value.ts b/src/value.ts',
  '--- a/src/value.ts',
  '+++ b/src/value.ts',
  '@@ -1 +1 @@',
  '-export const value = 1;',
  '+export const value = 2;',
  '',
].join('\n');
const revision = 'a'.repeat(40);
const patchHash = createHash('sha256').update(diff).digest('hex');
const pullRequest: GithubPullRequest = {
  number: 12, html_url: 'https://github.com/acme/app/pull/12',
  head: { sha: 'b'.repeat(40), ref: `asea/task-task1234-${patchHash.slice(0, 8)}` },
  base: { ref: 'main' },
};

describe('approved patch publication boundary', () => {
  it('creates one deterministic branch/PR and reuses both on retry', async () => {
    let branchSha: string | null = null;
    let pr: GithubPullRequest | null = null;
    const client = {
      getRef: vi.fn(async (_installation: string, _owner: string, _repo: string, branch: string) => {
        if (branch === 'main') return { sha: revision };
        if (branchSha) return { sha: branchSha };
        throw new GithubApiError(404, 'missing');
      }),
      getContent: vi.fn(async () => ({ type: 'file', encoding: 'base64', content: Buffer.from(original).toString('base64'), size: Buffer.byteLength(original) })),
      getCommit: vi.fn(async () => ({ sha: revision, tree: { sha: 'tree-base' }, message: 'base' })),
      getCommitMessage: vi.fn(async () => `ASEA task task-1234 patch ${patchHash}`),
      createBlob: vi.fn(async () => 'blob-new'),
      createTree: vi.fn(async () => 'tree-new'),
      createCommit: vi.fn(async () => 'b'.repeat(40)),
      createRef: vi.fn(async () => { branchSha = 'b'.repeat(40); }),
      listOpenPullRequests: vi.fn(async () => pr ? [pr] : []),
      createPullRequest: vi.fn(async () => { pr = pullRequest; return pullRequest; }),
    } as unknown as GithubAppClient;
    const input = {
      client, installationId: '99', repositoryFullName: 'acme/app', baseBranch: 'main', taskId: 'task-1234',
      patchHash, sourceRevision: revision, summary: 'Update a value', changedFiles: ['src/value.ts'],
      baseFiles: [{ path: 'src/value.ts', sha256: createHash('sha256').update(original).digest('hex') }], unifiedDiff: diff,
    };

    await expect(publishApprovedPatch(input)).resolves.toMatchObject({ branch: pullRequest.head.ref, commitSha: 'b'.repeat(40), pullRequest: { number: 12 } });
    await expect(publishApprovedPatch(input)).resolves.toMatchObject({ branch: pullRequest.head.ref, commitSha: 'b'.repeat(40), pullRequest: { number: 12 } });
    expect(client.createRef).toHaveBeenCalledTimes(1);
    expect(client.createPullRequest).toHaveBeenCalledTimes(1);
    expect(client.getContent).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale base branch before reading or writing files', async () => {
    const client = {
      getRef: vi.fn(async (_installation: string, _owner: string, _repo: string, branch: string) => {
        if (branch !== 'main') throw new GithubApiError(404, 'missing');
        return { sha: 'c'.repeat(40) };
      }),
      getContent: vi.fn(),
    } as unknown as GithubAppClient;
    await expect(publishApprovedPatch({
      client, installationId: '99', repositoryFullName: 'acme/app', baseBranch: 'main', taskId: 'task-1234',
      patchHash, sourceRevision: revision, summary: 'Stale patch', changedFiles: ['src/value.ts'],
      baseFiles: [{ path: 'src/value.ts', sha256: createHash('sha256').update(original).digest('hex') }], unifiedDiff: diff,
    })).rejects.toThrow(/base branch changed/);
    expect(client.getContent).not.toHaveBeenCalled();
  });

  it('summarizes only actual final CI check results', () => {
    expect(summarizeCiChecks([]).status).toBe('NOT_CONFIGURED');
    expect(summarizeCiChecks([{ name: 'unit', status: 'in_progress', conclusion: null, detailsUrl: null }]).status).toBe('PENDING');
    expect(summarizeCiChecks([{ name: 'unit', status: 'completed', conclusion: 'failure', detailsUrl: null }]).status).toBe('FAILURE');
    expect(summarizeCiChecks([{ name: 'unit', status: 'completed', conclusion: 'success', detailsUrl: null }]).status).toBe('SUCCESS');
    expect(summarizeCiChecks([{ name: 'unit', status: 'completed', conclusion: 'unexpected', detailsUrl: null }]).status).toBe('ERROR');
  });

  it('produces evidence-based CI diagnoses and maps GitHub annotation paths to files', () => {
    const checks = [{
      name: 'typecheck', status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/acme/app/actions/runs/1',
      failureSummary: 'TypeScript reported a compile error.',
      annotations: [{ path: 'src/api.ts', startLine: 22, endLine: 22, level: 'failure', title: 'Type error', message: 'Invalid return type' }],
    }];
    expect(diagnoseCiChecks('FAILURE', checks)).toMatchObject({
      status: 'FILES_IDENTIFIED', affectedFiles: ['src/api.ts'],
      summary: '1 failed check(s) reported annotations for 1 repository file(s).',
    });
    expect(diagnoseCiChecks('FAILURE', [{ name: 'build', status: 'completed', conclusion: 'failure', detailsUrl: null }]).status).toBe('NO_FILE_REFERENCES');
    expect(diagnoseCiChecks('PENDING', checks).status).toBe('PENDING');
    expect(diagnoseCiChecks('SUCCESS', checks).status).toBe('NO_FAILURES');
  });
});
