import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PatchCiStatus } from '@prisma/client';
import { applyUnifiedPatch } from '../engineering/safePatch.js';
import { GithubApiError, GithubAppClient, type GithubCheckSummary, type GithubPullRequest } from './githubAppClient.js';

const MAX_REMOTE_FILE_BYTES = 1024 * 1024;
const MAX_REMOTE_TOTAL_BYTES = 5 * 1024 * 1024;
const SAFE_SHA = /^[a-f0-9]{40,64}$/i;

export interface PatchBaseFile {
  path: string;
  sha256: string | null;
}

export interface PublishPatchInput {
  client: GithubAppClient;
  installationId: string;
  repositoryFullName: string;
  baseBranch: string;
  taskId: string;
  patchHash: string;
  sourceRevision: string;
  summary: string;
  changedFiles: string[];
  baseFiles: PatchBaseFile[];
  unifiedDiff: string;
}

export interface PublishPatchResult {
  branch: string;
  commitSha: string;
  pullRequest: GithubPullRequest;
}

function safePath(value: string): string {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.includes('\0')) {
    throw new Error('Patch contains an unsafe repository path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Patch contains an unsafe repository path');
  return value;
}

function parseRepo(fullName: string): { owner: string; repo: string } {
  const match = fullName.match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
  if (!match) throw new Error('The connected GitHub repository name is invalid');
  return { owner: match[1]!, repo: match[2]! };
}

async function lookupExistingBranch(client: GithubAppClient, installationId: string, owner: string, repo: string, branch: string, marker: string): Promise<string | null> {
  try {
    const ref = await client.getRef(installationId, owner, repo, branch);
    const message = await client.getCommitMessage(installationId, owner, repo, ref.sha);
    if (!message.split('\n').includes(marker)) throw new Error('The deterministic ASEA branch already exists with different content');
    return ref.sha;
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Rebuilds only the approved diff against its recorded GitHub base. Original
 * contents live in a disposable temp directory and are removed in all paths.
 */
export async function publishApprovedPatch(input: PublishPatchInput): Promise<PublishPatchResult> {
  if (!SAFE_SHA.test(input.sourceRevision)) throw new Error('Patch has no clean source revision and cannot be published');
  if (createHash('sha256').update(input.unifiedDiff, 'utf8').digest('hex') !== input.patchHash) throw new Error('Stored patch hash does not match the approved diff');
  const { owner, repo } = parseRepo(input.repositoryFullName);
  const normalizedFiles = input.baseFiles.map((entry) => ({ path: safePath(entry.path), sha256: entry.sha256 }));
  const expectedNames = [...input.changedFiles].map(safePath).sort();
  const baseNames = normalizedFiles.map((entry) => entry.path).sort();
  if (expectedNames.length === 0 || new Set(expectedNames).size !== expectedNames.length || expectedNames.join('\0') !== baseNames.join('\0')) {
    throw new Error('Patch file metadata does not match the approved changed-file list');
  }
  for (const entry of normalizedFiles) {
    if (entry.sha256 !== null && !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Patch base file metadata is invalid');
  }

  const branch = `asea/task-${input.taskId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}-${input.patchHash.slice(0, 8)}`;
  const marker = `ASEA task ${input.taskId} patch ${input.patchHash}`;
  const existingSha = await lookupExistingBranch(input.client, input.installationId, owner, repo, branch, marker);
  let commitSha = existingSha;

  if (!commitSha) {
    const baseRef = await input.client.getRef(input.installationId, owner, repo, input.baseBranch);
    if (baseRef.sha.toLowerCase() !== input.sourceRevision.toLowerCase()) {
      throw new Error('The GitHub base branch changed since this patch snapshot was created');
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-publish-'));
    const workDir = path.join(tempRoot, 'source');
    fs.mkdirSync(workDir, { mode: 0o700 });
    try {
      let remoteBytes = 0;
      for (const file of normalizedFiles) {
        const target = path.resolve(workDir, ...file.path.split('/'));
        if (!target.startsWith(`${workDir}${path.sep}`)) throw new Error('Patch path escapes its temporary workspace');
        if (file.sha256 === null) {
          try {
            await input.client.getContent(input.installationId, owner, repo, file.path, baseRef.sha);
            throw new Error(`New patch file already exists on GitHub: ${file.path}`);
          } catch (error) {
            if (!(error instanceof GithubApiError) || error.status !== 404) throw error;
          }
          continue;
        }
        const remote = await input.client.getContent(input.installationId, owner, repo, file.path, baseRef.sha);
        const bytes = Buffer.from(remote.content.replace(/\s/g, ''), 'base64');
        if (bytes.length !== remote.size || bytes.length > MAX_REMOTE_FILE_BYTES || bytes.includes(0)) {
          throw new Error(`GitHub base file is binary, oversized, or malformed: ${file.path}`);
        }
        if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw new Error(`GitHub base file is not valid UTF-8 text: ${file.path}`);
        remoteBytes += bytes.length;
        if (remoteBytes > MAX_REMOTE_TOTAL_BYTES) throw new Error('Changed GitHub base files exceed the publication limit');
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
          throw new Error(`GitHub base file changed since the patch snapshot was created: ${file.path}`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      }

      const applied = applyUnifiedPatch(tempRoot, workDir, input.unifiedDiff);
      if (applied.patchHash !== input.patchHash || [...applied.changedFiles].sort().join('\0') !== expectedNames.join('\0')) {
        throw new Error('Stored patch no longer matches its approved metadata');
      }
      const baseCommit = await input.client.getCommit(input.installationId, owner, repo, baseRef.sha);
      const entries: Array<{ path: string; sha: string }> = [];
      for (const relativePath of applied.changedFiles) {
        const filePath = path.resolve(workDir, ...relativePath.split('/'));
        const bytes = fs.readFileSync(filePath);
        if (bytes.length > MAX_REMOTE_FILE_BYTES || bytes.includes(0)) throw new Error(`Patched file is binary or exceeds the publication limit: ${relativePath}`);
        const blob = await input.client.createBlob(input.installationId, owner, repo, bytes.toString('base64'));
        entries.push({ path: relativePath, sha: blob });
      }
      const tree = await input.client.createTree(input.installationId, owner, repo, baseCommit.tree.sha, entries);
      const commit = await input.client.createCommit(input.installationId, owner, repo, marker, tree, baseRef.sha);
      try {
        await input.client.createRef(input.installationId, owner, repo, branch, commit);
        commitSha = commit;
      } catch (error) {
        // A concurrent retry may have created the same deterministic branch.
        const racedSha = await lookupExistingBranch(input.client, input.installationId, owner, repo, branch, marker);
        if (!racedSha) throw error;
        commitSha = racedSha;
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const openPulls = await input.client.listOpenPullRequests(input.installationId, owner, repo, branch, input.baseBranch);
  let pullRequest = openPulls.find((candidate) => candidate.head.ref === branch && candidate.base.ref === input.baseBranch);
  if (!pullRequest) {
    try {
      pullRequest = await input.client.createPullRequest(
        input.installationId, owner, repo, `ASEA: ${input.summary.replace(/[\r\n]+/g, ' ').slice(0, 100)}`,
        `Automated patch for task ${input.taskId}.\n\n${input.summary.slice(0, 3000)}\n\nPatch SHA-256: ${input.patchHash}\n\nThis pull request was published only after an authorized reviewer approved the exact patch.`,
        branch, input.baseBranch
      );
    } catch (error) {
      // Handle the GitHub 422 response when two retries race to open the same PR.
      const raced = await input.client.listOpenPullRequests(input.installationId, owner, repo, branch, input.baseBranch);
      const candidate = raced.find((item) => item.head.ref === branch && item.base.ref === input.baseBranch);
      if (!candidate) throw error;
      pullRequest = candidate;
    }
  }
  if (!pullRequest.html_url.startsWith('https://github.com/')) throw new Error('GitHub returned an invalid pull request URL');
  return { branch, commitSha: commitSha!, pullRequest };
}

export function summarizeCiChecks(checks: GithubCheckSummary[]): { status: PatchCiStatus; checks: GithubCheckSummary[] } {
  if (checks.length === 0) return { status: 'NOT_CONFIGURED', checks: [] };
  const failures = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
  if (checks.some((check) => failures.has((check.conclusion ?? check.status).toLowerCase()))) return { status: 'FAILURE', checks };
  if (checks.some((check) => !['success'].includes((check.conclusion ?? check.status).toLowerCase()))) {
    const inProgress = checks.some((check) => ['queued', 'in_progress', 'pending', 'requested', 'waiting'].includes(check.status.toLowerCase()));
    return { status: inProgress ? 'PENDING' : 'ERROR', checks };
  }
  return { status: 'SUCCESS', checks };
}

export interface CiDiagnosis {
  status: 'PENDING' | 'NO_FAILURES' | 'FILES_IDENTIFIED' | 'NO_FILE_REFERENCES' | 'DETAILS_UNAVAILABLE';
  summary: string;
  affectedFiles: string[];
  failedChecks: Array<{
    name: string;
    conclusion: string;
    detailsUrl: string | null;
    summary: string | null;
    annotations: NonNullable<GithubCheckSummary['annotations']>;
  }>;
}

/** Build a bounded, evidence-only diagnosis from GitHub check output and annotations. */
export function diagnoseCiChecks(status: PatchCiStatus, checks: GithubCheckSummary[]): CiDiagnosis {
  if (status === 'PENDING') return {
    status: 'PENDING', summary: 'GitHub checks are still running; wait for completion before diagnosing failures.', affectedFiles: [], failedChecks: [],
  };
  if (status === 'SUCCESS') return {
    status: 'NO_FAILURES', summary: 'All reported GitHub checks succeeded.', affectedFiles: [], failedChecks: [],
  };
  if (status === 'NOT_CONFIGURED' || status === 'ERROR') return {
    status: 'DETAILS_UNAVAILABLE', summary: status === 'NOT_CONFIGURED'
      ? 'GitHub has not reported any checks for this commit.'
      : 'GitHub check status is incomplete or could not be classified; no diagnosis is available.',
    affectedFiles: [], failedChecks: [],
  };

  const failing = checks.filter((check) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']
    .includes((check.conclusion ?? check.status).toLowerCase())).slice(0, 30);
  const failedChecks = failing.map((check) => ({
    name: check.name.slice(0, 120),
    conclusion: (check.conclusion ?? check.status).slice(0, 32),
    detailsUrl: check.detailsUrl,
    summary: check.failureSummary?.slice(0, 1600) ?? null,
    annotations: (check.annotations ?? []).slice(0, 25),
  }));
  const affectedFiles = [...new Set(failedChecks.flatMap((check) => check.annotations
    .map((annotation) => annotation.path).filter((file): file is string => Boolean(file))))].slice(0, 100);
  return {
    status: affectedFiles.length ? 'FILES_IDENTIFIED' : 'NO_FILE_REFERENCES',
    summary: affectedFiles.length
      ? `${failedChecks.length} failed check(s) reported annotations for ${affectedFiles.length} repository file(s).`
      : `${Math.max(1, failedChecks.length)} failed check(s) were reported, but GitHub supplied no file-specific annotations. Open a check for its full output.`,
    affectedFiles,
    failedChecks,
  };
}
