import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectRepositorySnapshot, validateAndCanonicalizePath } from '../intelligence/snapshotCollector.js';
import type { PatchContextFile } from './patchProposalClient.js';

const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const TASK_WORKSPACE_NAME = /^task-[a-f0-9]{40}-([a-f0-9]{8})-(\d{1,10})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;

export interface AbandonedWorkspaceCleanupResult {
  removed: number;
  failed: number;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false;
    // EPERM and unknown errors are treated as alive so cleanup fails safe.
    return true;
  }
}

/** Identifies this host in workspace names and sandbox container labels. */
export function workspaceHostToken(hostname = os.hostname()): string {
  return createHash('sha256').update(hostname).digest('hex').slice(0, 8);
}

/**
 * Reaps only direct task-workspace children owned by a dead worker process on
 * this host. The PID probe and opaque run suffix avoid deleting other live
 * worker replicas' workspaces when they share a root.
 */
export function cleanupAbandonedTaskWorkspaces(
  workspaceRootInput: string,
  isOwnerProcessAlive: (pid: number) => boolean = processIsAlive,
): AbandonedWorkspaceCleanupResult {
  if (!fs.existsSync(workspaceRootInput)) return { removed: 0, failed: 0 };
  const workspaceRoot = fs.realpathSync(workspaceRootInput);
  if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('Task workspace root must be a directory');
  const hostToken = workspaceHostToken();
  const result: AbandonedWorkspaceCleanupResult = { removed: 0, failed: 0 };

  for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = TASK_WORKSPACE_NAME.exec(entry.name);
    if (!match || match[1] !== hostToken) continue;
    const ownerPid = Number(match[2]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || isOwnerProcessAlive(ownerPid)) continue;
    try {
      removeTaskWorkspace(workspaceRoot, path.join(workspaceRoot, entry.name));
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export interface TaskWorkspace {
  path: string;
  snapshotHash: string;
  sourceRevision: string | null;
  copiedFiles: string[];
  copiedBytes: number;
}

/** A revision is publication-eligible only when the source checkout is clean. */
function getCleanSourceRevision(repoPath: string): string | null {
  try {
    const status = execFileSync('git', ['-C', repoPath, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (status) return null;
    const revision = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[a-f0-9]{40,64}$/i.test(revision) ? revision.toLowerCase() : null;
  } catch {
    // Non-Git roots, unavailable Git, or oversized status output are not
    // eligible for remote publication. Snapshot generation can still proceed.
    return null;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ensureNoOverlap(repoPath: string, workspaceRoot: string): void {
  if (isWithin(repoPath, workspaceRoot) || isWithin(workspaceRoot, repoPath)) {
    throw new Error('Task workspace root must be separate from the authorized repository');
  }
}

function resolveProspectivePath(targetInput: string): string {
  const target = path.resolve(targetInput);
  let existing = target;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Could not resolve task workspace root');
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...tail);
}

/**
 * Copies the bounded, secret-filtered repository snapshot into a new task-only
 * directory. The source checkout is only read and can contain uncommitted work.
 */
export async function createTaskWorkspace(input: {
  repositoryPath: string;
  workspaceRoot: string;
  taskId: string;
  allowedRoots?: string[];
}): Promise<TaskWorkspace> {
  if (!TASK_ID.test(input.taskId)) throw new Error('Invalid task id');
  const repoPath = validateAndCanonicalizePath(input.repositoryPath, input.allowedRoots);
  const prospectiveRoot = resolveProspectivePath(input.workspaceRoot);
  ensureNoOverlap(repoPath, prospectiveRoot);
  fs.mkdirSync(input.workspaceRoot, { recursive: true, mode: 0o700 });
  const workspaceRoot = fs.realpathSync(input.workspaceRoot);
  ensureNoOverlap(repoPath, workspaceRoot);

  const destination = path.join(workspaceRoot, input.taskId);
  if (!isWithin(workspaceRoot, destination) || destination === workspaceRoot) {
    throw new Error('Task workspace path escapes its configured root');
  }
  fs.mkdirSync(destination, { mode: 0o700 });

  try {
    const snapshot = await collectRepositorySnapshot(repoPath, { allowedRoots: [repoPath] });
    const copiedFiles: string[] = [];
    const hash = createHash('sha256');
    let copiedBytes = 0;

    for (const item of [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path))) {
      if (item.skippedReason) continue;
      const relative = item.path.replace(/\\/g, '/');
      const sourcePath = path.resolve(repoPath, ...relative.split('/'));
      const targetPath = path.resolve(destination, ...relative.split('/'));
      if (!isWithin(repoPath, sourcePath) || !isWithin(destination, targetPath)) {
        throw new Error('Snapshot contained a path outside its repository boundary');
      }

      // Resolve symlinks at read time and refuse targets outside the checkout.
      const realSource = fs.realpathSync(sourcePath);
      if (!isWithin(repoPath, realSource)) throw new Error(`Snapshot path escapes repository: ${relative}`);
      const stat = fs.statSync(realSource);
      if (!stat.isFile() || stat.size !== item.sizeBytes) throw new Error(`Snapshot file changed during copy: ${relative}`);
      const contents = fs.readFileSync(realSource);
      if (contents.includes(0)) continue;

      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(targetPath, contents, { flag: 'wx', mode: 0o600 });
      hash.update(relative).update('\0').update(contents).update('\0');
      copiedBytes += contents.byteLength;
      copiedFiles.push(relative);
    }

    copiedFiles.sort();
    return {
      path: destination,
      snapshotHash: hash.digest('hex'),
      sourceRevision: getCleanSourceRevision(repoPath),
      copiedFiles,
      copiedBytes,
    };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Removes only an existing task directory directly beneath the configured root. */
export function removeTaskWorkspace(workspaceRootInput: string, taskWorkspaceInput: string): void {
  const workspaceRoot = fs.realpathSync(workspaceRootInput);
  const taskWorkspace = path.resolve(taskWorkspaceInput);
  if (!isWithin(workspaceRoot, taskWorkspace) || taskWorkspace === workspaceRoot || path.relative(workspaceRoot, path.dirname(taskWorkspace)) !== '') {
    throw new Error('Refusing to remove a path outside the task workspace root');
  }
  const stat = fs.lstatSync(taskWorkspace);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Task workspace must be a real directory');
  if (!isWithin(workspaceRoot, fs.realpathSync(taskWorkspace))) {
    throw new Error('Task workspace resolves outside its configured root');
  }
  fs.rmSync(taskWorkspace, { recursive: true, force: false });
}

/** Selects bounded source context from the task copy; it never reads the original checkout. */
export function readPatchContextFiles(input: {
  taskWorkspacePath: string;
  copiedFiles: string[];
  requirement: string;
  maxFiles?: number;
  maxTotalBytes?: number;
}): PatchContextFile[] {
  const root = fs.realpathSync(input.taskWorkspacePath);
  if (fs.lstatSync(input.taskWorkspacePath).isSymbolicLink() || !fs.statSync(root).isDirectory()) {
    throw new Error('Task context must be read from a real workspace directory');
  }
  const tokens = new Set((input.requirement.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter((token) => token.length > 2));
  const candidates = [...new Set(input.copiedFiles)].map((relativePath) => {
    const normalized = relativePath.replace(/\\/g, '/');
    const pathTokens = normalized.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
    const relevance = pathTokens.reduce((score, token) => score + (tokens.has(token) ? 4 : 0), 0);
    const testBoost = /(^|\/)(test|tests|__tests__)(\/|\.)|\.(test|spec)\./i.test(normalized) ? 1 : 0;
    return { path: normalized, relevance: relevance + testBoost };
  }).sort((a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path));

  const maxFiles = Math.min(Math.max(input.maxFiles ?? 24, 1), 24);
  const maxTotalBytes = Math.min(Math.max(input.maxTotalBytes ?? 1_000_000, 1), 1_000_000);
  const selected: PatchContextFile[] = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (selected.length >= maxFiles || totalBytes >= maxTotalBytes) break;
    const target = path.resolve(root, ...candidate.path.split('/'));
    if (!isWithin(root, target) || target === root) throw new Error('Task snapshot contains an unsafe file path');
    if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) continue;
    const realTarget = fs.realpathSync(target);
    if (!isWithin(root, realTarget) || !fs.statSync(realTarget).isFile()) continue;
    const bytes = fs.readFileSync(realTarget);
    if (bytes.includes(0)) continue;
    let content = bytes.toString('utf8').slice(0, 20_000);
    while (Buffer.byteLength(content, 'utf8') > 80_000) content = content.slice(0, Math.floor(content.length * 0.9));
    const size = Buffer.byteLength(candidate.path, 'utf8') + Buffer.byteLength(content, 'utf8');
    if (totalBytes + size > maxTotalBytes) {
      const remaining = Math.max(0, maxTotalBytes - totalBytes - Buffer.byteLength(candidate.path, 'utf8'));
      if (remaining < 1) continue;
      content = Buffer.from(content, 'utf8').subarray(0, remaining).toString('utf8');
    }
    selected.push({ path: candidate.path, content });
    totalBytes += Buffer.byteLength(candidate.path, 'utf8') + Buffer.byteLength(content, 'utf8');
  }

  if (!selected.length) throw new Error('Task snapshot contains no eligible text files for patch generation');
  return selected;
}
