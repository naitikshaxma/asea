import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupAbandonedTaskWorkspaces, createTaskWorkspace, removeTaskWorkspace } from '../../src/services/engineering/taskWorkspace.js';
import { applyUnifiedPatch } from '../../src/services/engineering/safePatch.js';
import { SandboxUnavailableError, unavailableSandboxProvider } from '../../src/services/engineering/sandboxProvider.js';

const roots: string[] = [];
function tempRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-engineering-'));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('isolated task workspaces', () => {
  it('copies the current working tree snapshot without changing source and omits secret files', async () => {
    const parent = tempRoot();
    const repo = path.join(parent, 'repo');
    const workspaceRoot = path.join(parent, 'workspaces');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const value = 2;\n');
    fs.writeFileSync(path.join(repo, '.env'), 'secret=do-not-copy');

    const task = await createTaskWorkspace({ repositoryPath: repo, workspaceRoot, taskId: 'task-1', allowedRoots: [parent] });
    expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const value = 2;\n');
    expect(fs.readFileSync(path.join(task.path, 'src', 'app.ts'), 'utf8')).toBe('export const value = 2;\n');
    expect(fs.existsSync(path.join(task.path, '.env'))).toBe(false);
    expect(task.copiedFiles).toEqual(['src/app.ts']);
    expect(task.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a source symlink that escapes the authorized root', async () => {
    const parent = tempRoot();
    const repo = path.join(parent, 'repo');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'stolen.ts'), 'sensitive');
    fs.symlinkSync(outside, path.join(repo, 'escape'), 'junction');

    const task = await createTaskWorkspace({ repositoryPath: repo, workspaceRoot: path.join(parent, 'workspaces'), taskId: 'task-2', allowedRoots: [repo] });
    expect(fs.existsSync(path.join(task.path, 'escape', 'stolen.ts'))).toBe(false);
  });

  it('rejects a workspace root overlapping the source checkout and only removes its own task directory', async () => {
    const parent = tempRoot();
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    await expect(createTaskWorkspace({ repositoryPath: repo, workspaceRoot: path.join(repo, 'tasks'), taskId: 'task', allowedRoots: [repo] })).rejects.toThrow(/separate/);

    const workspaceRoot = path.join(parent, 'workspaces');
    fs.mkdirSync(workspaceRoot);
    const taskPath = path.join(workspaceRoot, 'task-3');
    fs.mkdirSync(taskPath);
    fs.writeFileSync(path.join(taskPath, 'file.txt'), 'x');
    removeTaskWorkspace(workspaceRoot, taskPath);
    expect(fs.existsSync(taskPath)).toBe(false);
    expect(fs.existsSync(repo)).toBe(true);
  });

  it('reaps only orphaned workspaces owned by a dead worker on this host', () => {
    const workspaceRoot = tempRoot();
    const hostToken = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8);
    const otherHostToken = hostToken === 'ffffffff' ? 'eeeeeeee' : 'ffffffff';
    const makePath = (token: string, pid: number) => path.join(workspaceRoot, `task-${'a'.repeat(40)}-${token}-${pid}-${randomUUID()}`);
    const orphan = makePath(hostToken, 424242);
    const active = makePath(hostToken, process.pid);
    const otherHost = makePath(otherHostToken, 424242);
    const unrelated = path.join(workspaceRoot, 'task-from-another-purpose');
    for (const directory of [orphan, active, otherHost, unrelated]) fs.mkdirSync(directory);

    const cleanup = cleanupAbandonedTaskWorkspaces(workspaceRoot, (pid) => pid === process.pid);
    expect(cleanup).toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(otherHost)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

describe('bounded unified patch application', () => {
  it('applies modifications and additions only inside the workspace', () => {
    const workspace = tempRoot();
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), 'const value = 1;\n');
    const patch = [
      '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-const value = 1;', '+const value = 2;',
      '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+export {};', '',
    ].join('\n');

    const result = applyUnifiedPatch(path.dirname(workspace), workspace, patch);
    expect(result.changedFiles).toEqual(['src/app.ts', 'src/new.ts']);
    expect(fs.readFileSync(path.join(workspace, 'src', 'app.ts'), 'utf8')).toBe('const value = 2;\n');
    expect(fs.readFileSync(path.join(workspace, 'src', 'new.ts'), 'utf8')).toBe('export {};\n');
    expect(result.patchHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['path traversal', '--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-a\n+b\n'],
    ['secret paths', '--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-a\n+b\n'],
    ['file deletions', '--- a/a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n'],
    ['renames', '--- a/a.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-a\n+b\n'],
  ])('rejects %s without changing files', (label, patch) => {
    const workspace = tempRoot();
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'a\n');
    expect(() => applyUnifiedPatch(path.dirname(workspace), workspace, patch)).toThrow();
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('a\n');
    expect(label).toBeTruthy();
  });

  it('rejects context mismatch before writing any target', () => {
    const workspace = tempRoot();
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'actual\n');
    const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-wrong\n+changed\n';
    expect(() => applyUnifiedPatch(path.dirname(workspace), workspace, patch)).toThrow(/context does not match/);
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('actual\n');
  });

  it('rolls back earlier file writes when a later filesystem write fails', () => {
    const workspace = tempRoot();
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old-a\n');
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'old-b\n');
    const patch = [
      '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-old-a', '+new-a',
      '--- a/b.txt', '+++ b/b.txt', '@@ -1 +1 @@', '-old-b', '+new-b', '',
    ].join('\n');
    const realRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync')
      .mockImplementationOnce(realRename as any)
      .mockImplementationOnce(() => { throw new Error('simulated write failure'); });

    expect(() => applyUnifiedPatch(path.dirname(workspace), workspace, patch)).toThrow('simulated write failure');
    rename.mockRestore();
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('old-a\n');
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toBe('old-b\n');
    expect(fs.readdirSync(workspace).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

it('keeps repository test execution explicitly unavailable without a sandbox', async () => {
  expect(unavailableSandboxProvider.available).toBe(false);
  await expect(unavailableSandboxProvider.execute({
    workspacePath: os.tmpdir(), command: ['npm', 'test'],
    limits: { timeoutMs: 1000, memoryMb: 128, cpuCount: 1, maxProcesses: 8, maxOutputBytes: 1024, network: 'disabled' },
  })).rejects.toBeInstanceOf(SandboxUnavailableError);
});
