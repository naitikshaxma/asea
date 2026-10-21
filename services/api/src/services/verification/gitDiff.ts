import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthorType, VerificationRequest } from '@autonomous-engineer/contracts';

const execFileAsync = promisify(execFile);

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const GIT_TIMEOUT_MS = 30000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// Repository config must not be able to run commands or change the output
// format we parse: no fsmonitor, external diff or textconv drivers; standard
// a/ b/ prefixes; unquoted paths.
const SAFE_GIT_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.quotePath=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'color.ui=false',
];

export class VerificationInputError extends Error {}

async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...SAFE_GIT_CONFIG, '-C', repoPath, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new VerificationInputError(`git ${args[0]} failed in ${repoPath}: ${detail}`);
  }
}

async function resolveCommit(repoPath: string, sha: string): Promise<string> {
  if (!SHA_PATTERN.test(sha)) {
    throw new VerificationInputError(`'${sha}' is not a 7-40 character hex commit SHA`);
  }
  return (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).trim();
}

/**
 * Builds the engine's VerificationRequest for baseSha..headSha of a local git
 * repository: the unified diff plus the head content of every added or
 * modified text file. git runs as an argument list (no shell) with a timeout.
 */
export async function buildVerificationRequest(input: {
  repositoryId: string;
  repoPath: string;
  baseSha: string;
  headSha: string;
  requirement: string;
  authorType: AuthorType;
  maxRequestBytes: number;
}): Promise<VerificationRequest> {
  const base = await resolveCommit(input.repoPath, input.baseSha);
  const head = await resolveCommit(input.repoPath, input.headSha);

  const diffArgs = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const unifiedDiff = await git(input.repoPath, ['diff', ...diffArgs, base, head, '--']);
  const names = await git(input.repoPath, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', base, head, '--']);

  const changedFiles: VerificationRequest['changed_files'] = [];
  for (const path of names.split('\0').filter(Boolean)) {
    const content = await git(input.repoPath, ['show', `${head}:${path}`]);
    if (content.includes('\0')) continue; // binary; the engine only analyses text
    changedFiles.push({ path, head_content: content });
  }

  const request: VerificationRequest = {
    repository_id: input.repositoryId,
    base_sha: base,
    head_sha: head,
    requirement: input.requirement,
    unified_diff: unifiedDiff,
    changed_files: changedFiles,
    author_type: input.authorType,
  };

  const size = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (size > input.maxRequestBytes) {
    throw new VerificationInputError(
      `Verification request is ${size} bytes, over the ${input.maxRequestBytes}-byte limit; verify a smaller change`
    );
  }
  return request;
}
