import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerSandboxProvider, spawnDockerProcess, type DockerProcessExecutor } from '../../src/services/engineering/dockerSandboxProvider.js';
import { workspaceHostToken } from '../../src/services/engineering/taskWorkspace.js';

const roots: string[] = [];
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-docker-sandbox-'));
  roots.push(root);
  const workspaceRoot = path.join(root, 'workspaces');
  const workspace = path.join(workspaceRoot, 'task-a');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  return { root, workspaceRoot, workspace };
}

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', durationMs: 2, timedOut: false, cancelled: false, outputTruncated: false });

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('DockerSandboxProvider', () => {
  it('requires an authorized direct-child workspace and an exact allowlisted argv', async () => {
    const { workspaceRoot, workspace } = makeWorkspace();
    const calls: Array<{ args: string[]; options: any }> = [];
    const executor: DockerProcessExecutor = async (_exe, args, options) => { calls.push({ args, options }); return ok('container output'); };
    const provider = new DockerSandboxProvider({ image: 'asea/sandbox:test', workspaceRoot }, executor);

    const result = await provider.execute({
      workspacePath: workspace, workspaceReadOnly: true, command: ['node', '--test'],
      limits: { timeoutMs: 10000, memoryMb: 512, cpuCount: 2, maxProcesses: 64, maxOutputBytes: 4096, network: 'disabled' },
    });
    expect(result.stdout).toBe('container output');
    const args = calls[0]!.args;
    expect(args).toContain('--network=none');
    expect(args).toContain('--log-driver=none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--security-opt=seccomp=builtin');
    expect(args).toContain('--memory=512m');
    expect(args).toContain('--memory-swap=512m');
    expect(args).toContain('--cpus=2');
    expect(args.some((arg) => arg.startsWith('--mount=type=bind,') && arg.endsWith(',readonly'))).toBe(true);
    expect(args.some((arg) => /docker\.sock/i.test(arg))).toBe(false);
    expect(args).toContain('asea/sandbox:test');
    expect(args.slice(args.indexOf('asea/sandbox:test') + 1, args.indexOf('asea/sandbox:test') + 5)).toEqual([
      'timeout', '--signal=TERM', '--kill-after=5s', '10s',
    ]);

    await provider.execute({
      workspacePath: workspace, command: ['node', '--test'],
      limits: { timeoutMs: 10000, memoryMb: 512, cpuCount: 2, maxProcesses: 64, maxOutputBytes: 4096, workspaceSizeMb: 128, network: 'disabled' },
    });
    const writableArgs = calls[1]!.args;
    expect(writableArgs).toContain(`--mount=type=bind,source=${workspace.replace(/\\/g, '/')},target=/input,readonly`);
    expect(writableArgs).toContain('--tmpfs=/workspace:rw,nosuid,nodev,size=134217728,mode=1777');
    expect(writableArgs.some((arg) => arg.includes(`source=${workspace.replace(/\\/g, '/')},target=/workspace`))).toBe(false);
    expect(writableArgs.slice(writableArgs.indexOf('asea/sandbox:test') + 1)).toContain('if [ -d /input ]; then cp -R /input/. /workspace/; fi; exec "$@"');

    await expect(provider.execute({
      workspacePath: workspace, command: ['node', '-e', 'process.exit(0)'],
      limits: { timeoutMs: 1000, memoryMb: 128, cpuCount: 1, maxProcesses: 16, maxOutputBytes: 1024, network: 'disabled' },
    })).rejects.toThrow(/not allowed/);
    await expect(provider.execute({
      workspacePath: path.join(workspaceRoot, '..'), command: ['node', '--test'],
      limits: { timeoutMs: 1000, memoryMb: 128, cpuCount: 1, maxProcesses: 16, maxOutputBytes: 1024, network: 'disabled' },
    })).rejects.toThrow(/direct child/);
    expect(calls).toHaveLength(2);
  });

  it('labels every sandbox container with this host and worker PID', async () => {
    const { workspaceRoot, workspace } = makeWorkspace();
    const executor = vi.fn<DockerProcessExecutor>().mockResolvedValue(ok());
    const provider = new DockerSandboxProvider({ image: 'asea/sandbox:test', workspaceRoot }, executor);
    await provider.execute({
      workspacePath: workspace, command: ['node', '--test'],
      limits: { timeoutMs: 1000, memoryMb: 128, cpuCount: 1, maxProcesses: 16, maxOutputBytes: 1024, network: 'disabled' },
    });
    const args = executor.mock.calls[0]![1];
    expect(args).toEqual(expect.arrayContaining([
      '--label=io.asea.sandbox=v1', `--label=io.asea.sandbox.host=${workspaceHostToken()}`, `--label=io.asea.sandbox.pid=${process.pid}`,
    ]));
    // Labels precede the image, so they cannot be read as part of the command
    expect(args.indexOf('--label=io.asea.sandbox=v1')).toBeLessThan(args.indexOf('asea/sandbox:test'));
  });

  it('reaps only labelled containers of a dead worker on this host', async () => {
    const { workspaceRoot } = makeWorkspace();
    const host = workspaceHostToken();
    const id = (n: number) => String(n).repeat(64).slice(0, 64);
    const name = (n: number) => `asea-sbx-${String(n).repeat(32).slice(0, 32)}`;
    const listing = [
      `${id(1)}|${name(1)}|${host}|4001`, // dead owner: removed
      `${id(2)}|${name(2)}|${host}|4002`, // live owner: kept
      `${id(3)}|${name(3)}|${host}|${process.pid}`, // this worker: kept
      `${id(4)}|${name(4)}|deadbeef|4001`, // other host: kept
      `${id(5)}|my-own-container|${host}|4001`, // not a sandbox name: kept
      `${id(6)}|${name(6)}|${host}|`, // missing PID label: kept
      `${id(7)}|${name(7)}|${host}|4007`, // dead owner, removal fails
      '',
    ].join('\n');
    const executor = vi.fn<DockerProcessExecutor>(async (_exe, args) => {
      if (args[0] === 'ps') return ok(listing);
      return args[2] === id(7) ? { ...ok(), exitCode: 1 } : ok();
    });
    const provider = new DockerSandboxProvider({ image: 'asea/sandbox:test', workspaceRoot }, executor);

    const result = await provider.reapAbandonedContainers((pid) => pid === 4002);

    expect(result).toEqual({ removed: 1, failed: 1 });
    expect(executor.mock.calls[0]![1]).toEqual(expect.arrayContaining([
      'ps', '--all', '--filter', 'label=io.asea.sandbox=v1', '--filter', `label=io.asea.sandbox.host=${host}`,
    ]));
    expect(executor.mock.calls.slice(1).map((call) => call[1])).toEqual([['rm', '--force', id(1)], ['rm', '--force', id(7)]]);
  });

  it('fails closed without removing anything when containers cannot be listed', async () => {
    const { workspaceRoot } = makeWorkspace();
    const executor = vi.fn<DockerProcessExecutor>().mockResolvedValue({ ...ok(), exitCode: 1 });
    const provider = new DockerSandboxProvider({ image: 'asea/sandbox:test', workspaceRoot }, executor);
    await expect(provider.reapAbandonedContainers(() => false)).rejects.toThrow(/Could not list/);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('reports the daemon and image separately without pulling images', async () => {
    const { workspaceRoot } = makeWorkspace();
    const executor = vi.fn<DockerProcessExecutor>()
      .mockResolvedValueOnce(ok('28.0.0'))
      .mockResolvedValueOnce({ ...ok(), exitCode: 1 });
    const provider = new DockerSandboxProvider({ image: 'asea/sandbox:test', workspaceRoot }, executor);
    const diagnostics = await provider.diagnose();
    expect(diagnostics).toMatchObject({ status: 'UNAVAILABLE', reasonCode: 'IMAGE_MISSING' });
    expect(executor.mock.calls.map((call) => call[1])).toEqual([
      ['info', '--format', '{{.ServerVersion}}'],
      ['image', 'inspect', '--format', '{{.Id}}', 'asea/sandbox:test'],
    ]);
  });

  it('maps the in-container deadline exit code to an explicit timeout result', async () => {
    const { workspaceRoot, workspace } = makeWorkspace();
    const executor: DockerProcessExecutor = async () => ({ ...ok(), exitCode: 124 });
    const provider = new DockerSandboxProvider({ image: 'asea/sandbox:test', workspaceRoot }, executor);
    const execution = await provider.execute({
      workspacePath: workspace, command: ['node', '--test'],
      limits: { timeoutMs: 1000, memoryMb: 128, cpuCount: 1, maxProcesses: 16, maxOutputBytes: 1024, network: 'disabled' },
    });
    expect(execution).toMatchObject({ exitCode: null, timedOut: true });
  });

  it('terminates a timed-out local process and reports the timeout', async () => {
    const result = await spawnDockerProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 1000, maxOutputBytes: 1024 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('terminates a cancelled local process and reports cancellation', async () => {
    const controller = new AbortController();
    const promise = spawnDockerProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 5000, maxOutputBytes: 1024, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});
