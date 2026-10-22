import { execFile, spawn } from 'node:child_process';
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

/** The full SHA of a commit given by a 7-40 character hex prefix. */
export async function resolveCommit(repoPath: string, sha: string): Promise<string> {
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

export interface GitBranch {
  name: string;
  sha: string;
  subject: string;
  committedAt: string;
}

/** Local branches of a repository, most recently committed first. */
export async function listBranches(repoPath: string): Promise<GitBranch[]> {
  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)',
    'refs/heads',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = '', committedAt = '', subject = ''] = line.split('\0');
      return { name, sha, subject, committedAt: new Date(committedAt).toISOString() };
    });
}

export interface TreeFile {
  path: string;
  content: string;
}

/**
 * Text files of one commit whose names end with one of `extensions`, read with
 * a single `git cat-file --batch` process. Files are taken in path order until
 * `maxFiles` or `maxBytes` is reached (then `truncated` is true); files over
 * 1 MiB and binary files are skipped.
 */
export async function readTreeFiles(
  repoPath: string,
  sha: string,
  limits: { extensions: string[]; maxFiles: number; maxBytes: number }
): Promise<{ commitSha: string; files: TreeFile[]; truncated: boolean }> {
  const commitSha = await resolveCommit(repoPath, sha);
  const listing = await git(repoPath, ['ls-tree', '-r', '-z', '--long', commitSha]);
  const candidates = listing
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      // "<mode> <type> <object> <size>\t<path>"
      const tab = entry.indexOf('\t');
      const [, type = '', object = '', size = ''] = entry.slice(0, tab).trim().split(/\s+/);
      return { type, object, size: Number(size), path: entry.slice(tab + 1) };
    })
    .filter((e) => e.type === 'blob' && e.size <= 1024 * 1024 && limits.extensions.some((ext) => e.path.endsWith(ext)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const selected: typeof candidates = [];
  let total = 0;
  for (const entry of candidates) {
    if (selected.length >= limits.maxFiles || total + entry.size > limits.maxBytes) break;
    selected.push(entry);
    total += entry.size;
  }
  const contents = await catFileBatch(repoPath, selected.map((e) => e.object));
  const files = selected
    .map((e, i) => ({ path: e.path, content: contents[i] ?? '' }))
    .filter((f) => !f.content.includes('\0'));
  return { commitSha, files, truncated: selected.length < candidates.length };
}

/** Contents of the given blob ids, in order, from one `git cat-file --batch`. */
function catFileBatch(repoPath: string, objects: string[]): Promise<string[]> {
  if (objects.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_GIT_CONFIG, '-C', repoPath, 'cat-file', '--batch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let received = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new VerificationInputError(`git cat-file timed out in ${repoPath}`));
    }, GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > GIT_MAX_BUFFER) {
        child.kill();
        reject(new VerificationInputError(`git cat-file output exceeded ${GIT_MAX_BUFFER} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new VerificationInputError(`git cat-file failed in ${repoPath}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new VerificationInputError(`git cat-file exited with ${code} in ${repoPath}`));
        return;
      }
      const out = Buffer.concat(chunks);
      const contents: string[] = [];
      let offset = 0;
      for (let i = 0; i < objects.length; i++) {
        const newline = out.indexOf(0x0a, offset);
        const header = out.subarray(offset, newline).toString('utf8').split(' ');
        const size = Number(header[2]);
        if (header[1] !== 'blob' || !Number.isFinite(size)) {
          reject(new VerificationInputError(`git cat-file returned an unexpected header: ${header.join(' ')}`));
          return;
        }
        contents.push(out.subarray(newline + 1, newline + 1 + size).toString('utf8'));
        offset = newline + 1 + size + 1; // content is followed by a newline
      }
      resolve(contents);
    });
    child.stdin.end(objects.join('\n') + '\n');
  });
}
