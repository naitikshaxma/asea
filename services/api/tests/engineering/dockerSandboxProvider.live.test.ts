import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerSandboxProvider, spawnDockerProcess, type DockerProcessExecutor } from '../../src/services/engineering/dockerSandboxProvider.js';
import { runRepositoryTests } from '../../src/services/engineering/testRunner.js';
import { runSecurityScans } from '../../src/services/engineering/securityScanner.js';
import { redactSensitiveText } from '../../src/services/engineering/outputRedaction.js';
import { cleanupAbandonedTaskWorkspaces, createTaskWorkspace, removeTaskWorkspace, workspaceHostToken } from '../../src/services/engineering/taskWorkspace.js';
import type { SandboxLimits } from '../../src/services/engineering/sandboxProvider.js';

const image = process.env.ASEA_LIVE_SANDBOX_IMAGE;
const describeLive = describe.skipIf(!image);
const liveLimits: SandboxLimits = {
  timeoutMs: 20_000, memoryMb: 512, cpuCount: 1, maxProcesses: 32, maxOutputBytes: 4096,
  workspaceSizeMb: 64, network: 'disabled',
};

const fixtureRoots: string[] = [];
const createdContainerNames: string[] = [];
const interruptedWorkerChildren: ChildProcess[] = [];
const runtimeSnapshots = new Map<string, Promise<Record<string, any> | null>>();

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-docker-sandbox-live-'));
  fixtureRoots.push(root);
  return root;
}

function writeRepository(root: string, testSource: string, name = 'fixture-repository'): string {
  const repository = path.join(root, name);
  fs.mkdirSync(repository, { recursive: true });
  fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(repository, 'fixture.test.js'), testSource);
  return repository;
}

async function runInTaskWorkspace(input: {
  root: string;
  repository: string;
  limits?: SandboxLimits;
  signal?: AbortSignal;
}): Promise<{ report: Awaited<ReturnType<typeof runRepositoryTests>>; workspaceRoot: string }> {
  const workspaceRoot = path.join(input.root, 'task-workspaces');
  let taskWorkspacePath: string | null = null;
  try {
    const taskWorkspace = await createTaskWorkspace({
      repositoryPath: input.repository,
      workspaceRoot,
      taskId: `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      allowedRoots: [input.repository],
    });
    taskWorkspacePath = taskWorkspace.path;
    const provider = liveProvider(workspaceRoot);
    const report = await runRepositoryTests({
      workspacePath: taskWorkspace.path,
      provider,
      limits: input.limits ?? liveLimits,
      signal: input.signal,
    });
    return { report, workspaceRoot };
  } finally {
    if (taskWorkspacePath) removeTaskWorkspace(workspaceRoot, taskWorkspacePath);
  }
}

function liveProvider(workspaceRoot: string): DockerSandboxProvider {
  const executor: DockerProcessExecutor = (executable, args, options) => {
    const run = spawnDockerProcess(executable, args, options);
    if (args[0] === 'run' && options.containerName) {
      createdContainerNames.push(options.containerName);
      runtimeSnapshots.set(options.containerName, waitForRuntime(executable, options.containerName).catch(() => null));
    }
    return run;
  };
  return new DockerSandboxProvider({ image: image!, workspaceRoot }, executor);
}

function inspector(executable: string, args: string[], timeoutMs = 1500) {
  return spawnDockerProcess(executable, args, { timeoutMs, maxOutputBytes: 64 * 1024 });
}

async function waitForRuntime(executable: string, name: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = await inspector(executable, [
      'inspect', '--format', '{{json .HostConfig}}|{{json .Mounts}}|{{json .Config.Env}}', name,
    ]);
    if (result.exitCode === 0) {
      const [hostConfigJson, mountsJson, environmentJson] = result.stdout.split('|');
      const hostConfig = JSON.parse(hostConfigJson ?? '{}');
      const mounts = JSON.parse(mountsJson ?? '[]');
      const environment = JSON.parse(environmentJson ?? '[]') as string[];
      return {
        hostConfig,
        mounts,
        environmentNames: environment.map((entry) => entry.split('=', 1)[0]),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Docker did not expose the live sandbox container configuration in time.');
}

async function expectContainerRemoved(name?: string): Promise<void> {
  if (!name) throw new Error('The sandbox provider did not start a named container.');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await inspector('docker', ['inspect', '--format', '{{.State.Status}}', name]);
    if (result.exitCode !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The sandbox container was not removed within five seconds.');
}

afterEach(async () => {
  for (const child of interruptedWorkerChildren.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  }
  for (const name of createdContainerNames.splice(0)) {
    // Names come only from this test's DockerSandboxProvider invocations.
    await inspector('docker', ['rm', '--force', name]).catch(() => undefined);
  }
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  runtimeSnapshots.clear();
  vi.unstubAllEnvs();
  // A timed-out hook keeps running and would delete the next test's fixtures,
  // so allow for slow `docker rm` calls on a busy engine.
}, 60_000);

describeLive('DockerSandboxProvider live disposable fixtures', () => {
  it('runs passing commands in a tmpfs-backed workspace and inspects effective limits', async () => {
    const root = fixtureRoot();
    const sentinel = 'ASEA_HOST_ONLY_SENTINEL_SECRET_41f2c830';
    vi.stubEnv('ASEA_LIVE_HOST_SENTINEL_SECRET', sentinel);
    const repository = writeRepository(root, `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      test('runs in bounded isolated storage', async () => {
        assert.notEqual(process.getuid?.(), 0);
        assert.equal(process.cwd(), '/workspace');
        assert.equal(fs.existsSync('/input/package.json'), true);
        assert.equal(fs.existsSync('/var/run/docker.sock'), false);
        assert.equal(process.env.ASEA_LIVE_HOST_SENTINEL_SECRET, undefined);
        assert.throws(() => fs.writeFileSync('/input/package.json', 'tampered'), { code: 'EROFS' });
        assert.throws(() => fs.writeFileSync('/etc/asea-sandbox-boundary-probe', 'no'), { code: 'EROFS' });
        await assert.rejects(fetch('https://example.com', { signal: AbortSignal.timeout(1500) }));
        await new Promise(resolve => setTimeout(resolve, 1200));
      });
    `);
    const taskWorkspace = await createTaskWorkspace({ repositoryPath: repository, workspaceRoot: path.join(root, 'task-workspaces'), taskId: 'test-live-pass', allowedRoots: [repository] });
    try {
      const provider = liveProvider(path.join(root, 'task-workspaces'));
      const report = await runRepositoryTests({ workspacePath: taskWorkspace.path, provider, limits: liveLimits });
      expect(report.status, JSON.stringify({ reason: report.reason, summaries: report.commands.map((command) => command.summary) })).toBe('PASSED');
      expect(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).toContain('node --test');
      expect(fs.readdirSync(taskWorkspace.path)).not.toContain('quota.bin');
      expect(fs.readdirSync(path.join(root, 'task-workspaces'))).toContain(path.basename(taskWorkspace.path));

      const name = createdContainerNames.find((entry) => entry.startsWith('asea-sbx-'));
      const runtime = await runtimeSnapshots.get(name!)!;
      expect(runtime).not.toBeNull();
      const effective = runtime!;
      expect(effective.hostConfig.NetworkMode).toBe('none');
      expect(effective.hostConfig.LogConfig.Type).toBe('none');
      expect(effective.hostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(effective.hostConfig.MemorySwap).toBe(512 * 1024 * 1024);
      expect(effective.hostConfig.PidsLimit).toBe(32);
      expect(effective.hostConfig.NanoCpus).toBe(1_000_000_000);
      expect(effective.hostConfig.ReadonlyRootfs).toBe(true);
      expect(effective.hostConfig.SecurityOpt).toContain('seccomp=builtin');
      expect(effective.hostConfig.Tmpfs['/workspace']).toContain('size=67108864');
      expect(effective.mounts.some((mount: any) => mount.Type === 'bind' && mount.Destination === '/input' && !mount.RW)).toBe(true);
      expect(effective.mounts.some((mount: any) => /docker\.sock/i.test(String(mount.Source) + String(mount.Destination)))).toBe(false);
      expect(effective.environmentNames).not.toContain('ASEA_LIVE_HOST_SENTINEL_SECRET');
      await expectContainerRemoved(name);
    } finally {
      removeTaskWorkspace(path.join(root, 'task-workspaces'), taskWorkspace.path);
    }
  }, 30_000);

  it('runs packaged scanners on disposable fixtures and keeps actual secret evidence redacted', async () => {
    const root = fixtureRoot();
    const repository = writeRepository(root, "import test from 'node:test'; test('fixture only', () => {});");
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    // Generated per run so no token-shaped literal is committed; still matches Gitleaks' github-pat rule
    const syntheticSecret = `ghp_${randomBytes(27).toString('base64').replace(/[^A-Za-z0-9]/g, 'x')}`;
    fs.writeFileSync(path.join(repository, 'src', 'credentials.js'), `const password = "fixture-only password with spaces";\nconst token = "${syntheticSecret}";\n`);
    fs.writeFileSync(path.join(repository, 'package-lock.json'), JSON.stringify({
      name: 'asea-disposable-vulnerability-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'asea-disposable-vulnerability-fixture', version: '1.0.0', dependencies: { lodash: '4.17.20' } },
        'node_modules/lodash': { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz' },
      },
    }, null, 2));

    const workspaceRoot = path.join(root, 'task-workspaces');
    const taskWorkspace = await createTaskWorkspace({ repositoryPath: repository, workspaceRoot, taskId: 'scanner-fixture', allowedRoots: [repository] });
    try {
      const report = await runSecurityScans({ workspacePath: taskWorkspace.path, provider: liveProvider(workspaceRoot), limits: { ...liveLimits, timeoutMs: 120_000, memoryMb: 1024, maxOutputBytes: 262_144 } });
      expect(report.status).toBe('FAILED');
      expect(report.tools.map((tool) => tool.scanner)).toEqual(['gitleaks', 'semgrep', 'osv-scanner']);
      const scannerStatuses = report.tools.map(({ scanner, version, status, exitCode, summary, findings }) => ({ scanner, version, status, exitCode, summary, findingIds: findings.map(({ id }) => id) }));
      expect(report.tools.every((tool) => tool.version && tool.status === 'FAILED'), JSON.stringify(scannerStatuses)).toBe(true);
      expect(report.tools.find((tool) => tool.scanner === 'gitleaks')?.version).toContain('8.30.1');
      expect(report.tools.find((tool) => tool.scanner === 'semgrep')?.version).toContain('1.181.0');
      expect(report.tools.find((tool) => tool.scanner === 'osv-scanner')?.version).toContain('2.7.0');
      expect(report.tools.some((tool) => tool.scanner === 'gitleaks' && tool.findings.length > 0)).toBe(true);
      expect(report.tools.some((tool) => tool.scanner === 'semgrep' && tool.findings.some((finding) => finding.id.endsWith('asea-hard-coded-credential-assignment')))).toBe(true);
      expect(report.tools.some((tool) => tool.scanner === 'osv-scanner' && tool.findings.some((finding) => finding.path?.endsWith('package-lock.json')))).toBe(true);
      expect(JSON.stringify(report)).not.toContain(syntheticSecret);
      expect(fs.readFileSync(path.join(repository, 'src', 'credentials.js'), 'utf8')).toContain(syntheticSecret);
    } finally {
      removeTaskWorkspace(workspaceRoot, taskWorkspace.path);
    }
  }, 150_000);

  it('runs the pinned pytest runtime inside the sandbox', async () => {
    const root = fixtureRoot();
    const repository = path.join(root, 'python-fixture');
    fs.mkdirSync(path.join(repository, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'pytest.ini'), '[pytest]\n');
    fs.writeFileSync(path.join(repository, 'tests', 'test_runtime.py'), 'def test_runs_in_sandbox():\n    assert __import__("os").getuid() != 0\n');
    const workspaceRoot = path.join(root, 'task-workspaces');
    const taskWorkspace = await createTaskWorkspace({ repositoryPath: repository, workspaceRoot, taskId: 'pytest-fixture', allowedRoots: [repository] });
    try {
      const report = await runRepositoryTests({ workspacePath: taskWorkspace.path, provider: liveProvider(workspaceRoot), limits: liveLimits });
      expect(report.status).toBe('PASSED');
      expect(report.commands[0]?.name).toBe('pytest');
      expect(report.commands[0]?.stdout).toContain('1 passed');
      expect(fs.readdirSync(workspaceRoot)).toContain(path.basename(taskWorkspace.path));
    } finally {
      removeTaskWorkspace(workspaceRoot, taskWorkspace.path);
    }
  }, 30_000);

  it('reports a clean disposable repository as clean only when every scanner succeeds', async () => {
    const root = fixtureRoot();
    const repository = writeRepository(root, "import test from 'node:test'; test('fixture only', () => {});");
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'src', 'safe.js'), 'export const add = (left, right) => left + right;\n');
    fs.writeFileSync(path.join(repository, 'package-lock.json'), JSON.stringify({
      name: 'asea-disposable-clean-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'asea-disposable-clean-fixture', version: '1.0.0', dependencies: { lodash: '4.18.0' } },
        'node_modules/lodash': { version: '4.18.0', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.18.0.tgz' },
      },
    }, null, 2));
    const workspaceRoot = path.join(root, 'task-workspaces');
    const taskWorkspace = await createTaskWorkspace({ repositoryPath: repository, workspaceRoot, taskId: 'clean-scanner-fixture', allowedRoots: [repository] });
    try {
      const report = await runSecurityScans({ workspacePath: taskWorkspace.path, provider: liveProvider(workspaceRoot), limits: { ...liveLimits, timeoutMs: 120_000, memoryMb: 1024, maxOutputBytes: 262_144 } });
      const scannerStatuses = report.tools.map(({ scanner, version, status, exitCode, summary, findings }) => ({ scanner, hasVersion: Boolean(version), status, exitCode, summary, findingIds: findings.map(({ id }) => id) }));
      expect(report.status, JSON.stringify(scannerStatuses)).toBe('PASSED');
      expect(report.tools.map(({ scanner, status, version }) => ({ scanner, status, hasVersion: Boolean(version) }))).toEqual([
        { scanner: 'gitleaks', status: 'PASSED', hasVersion: true },
        { scanner: 'semgrep', status: 'PASSED', hasVersion: true },
        { scanner: 'osv-scanner', status: 'PASSED', hasVersion: true },
      ]);
    } finally {
      removeTaskWorkspace(workspaceRoot, taskWorkspace.path);
    }
  }, 150_000);

  it('enforces the tmpfs workspace limit and removes the container after disk exhaustion', async () => {
    const root = fixtureRoot();
    const repository = writeRepository(root, `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      test('the workspace reaches ENOSPC at the configured filesystem cap', () => {
        const fd = fs.openSync('/workspace/quota.bin', 'w');
        const block = Buffer.alloc(1024 * 1024, 65);
        let bytes = 0;
        let quotaApplied = false;
        try {
          while (true) { fs.writeSync(fd, block); bytes += block.length; }
        } catch (error) {
          quotaApplied = error.code === 'ENOSPC';
        } finally { fs.closeSync(fd); }
        assert.equal(quotaApplied, true);
        assert.ok(bytes <= 64 * 1024 * 1024);
      });
    `);
    const { report, workspaceRoot } = await runInTaskWorkspace({ root, repository });
    expect(report.status).toBe('PASSED');
    expect(fs.readdirSync(repository)).not.toContain('quota.bin');
    expect(fs.readdirSync(workspaceRoot)).toEqual([]);
    expect(createdContainerNames.length).toBeGreaterThan(0);
    await expectContainerRemoved(createdContainerNames.at(-1));
  }, 45_000);

  it('redacts synthetic secrets from real stdout, stderr and failing test diagnostics', async () => {
    const root = fixtureRoot();
    const secret = 'ASEA_LIVE_SYNTHETIC_SECRET_819af027';
    vi.stubEnv('ASEA_LIVE_OUTPUT_SECRET', secret);
    const repository = writeRepository(root, `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      test('writes secret-shaped output', () => {
        console.log('stdout ${secret}');
        console.error('stderr API_TOKEN=${secret}');
      });
      test('failure diagnostic is also sanitized', () => {
        assert.fail('AssertionError included ${secret}');
      });
    `);
    const { report, workspaceRoot } = await runInTaskWorkspace({ root, repository });
    expect(report.status).toBe('FAILED');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).toContain('[REDACTED]');
    expect(fs.readdirSync(workspaceRoot)).toEqual([]);
    await expectContainerRemoved(createdContainerNames.at(-1));
  }, 30_000);

  it('marks bounded output as failure and cleans the workspace after cancellation and timeout', async () => {
    const root = fixtureRoot();
    const repository = writeRepository(root, `
      import test from 'node:test';
      test('waits so the sandbox can be stopped safely', async () => {
        await new Promise(resolve => setTimeout(resolve, 30_000));
      });
    `);
    const outputRepository = writeRepository(root, `
      import test from 'node:test';
      test('writes too much output', () => { process.stdout.write('X'.repeat(8192)); });
    `, 'output-repository');
    const output = await runInTaskWorkspace({
      root, repository: outputRepository,
      limits: { ...liveLimits, maxOutputBytes: 1024 },
    });
    expect(output.report.status).toBe('FAILED');
    expect(output.report.commands[0]?.outputTruncated).toBe(true);
    expect(Buffer.byteLength(output.report.commands[0]?.stdout ?? '') + Buffer.byteLength(output.report.commands[0]?.stderr ?? '')).toBeLessThanOrEqual(1024);
    expect(fs.readdirSync(output.workspaceRoot)).toEqual([]);
    await expectContainerRemoved(createdContainerNames.at(-1));

    const timeout = await runInTaskWorkspace({ root, repository, limits: { ...liveLimits, timeoutMs: 4000, maxOutputBytes: 65_536 } });
    expect(timeout.report.status, JSON.stringify({
      exit: timeout.report.commands[0]?.exitCode,
      summary: timeout.report.commands[0]?.summary,
      truncated: timeout.report.commands[0]?.outputTruncated,
      stdout: redactSensitiveText(timeout.report.commands[0]?.stdout ?? '', { maxBytes: 200 }),
      stderr: redactSensitiveText(timeout.report.commands[0]?.stderr ?? '', { maxBytes: 200 }),
    })).toBe('TIMED_OUT');
    expect(fs.readdirSync(timeout.workspaceRoot)).toEqual([]);
    await expectContainerRemoved(createdContainerNames.at(-1));

    const cancellation = new AbortController();
    const running = runInTaskWorkspace({ root, repository, signal: cancellation.signal });
    const cancellationDeadline = Date.now() + 10_000;
    while (createdContainerNames.length < 3 && Date.now() < cancellationDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    cancellation.abort();
    const cancelled = await running;
    expect(cancelled.report.status).toBe('CANCELLED');
    expect(fs.readdirSync(cancelled.workspaceRoot)).toEqual([]);
    await expectContainerRemoved(createdContainerNames.at(-1));
  }, 60_000);

  it('rejects prohibited commands before any container is started', async () => {
    const root = fixtureRoot();
    const repository = writeRepository(root, "import test from 'node:test'; test('fixture only', () => {});");
    const workspaceRoot = path.join(root, 'task-workspaces');
    const taskWorkspace = await createTaskWorkspace({
      repositoryPath: repository, workspaceRoot, taskId: `prohibited-${Date.now()}`, allowedRoots: [repository],
    });
    try {
      const provider = liveProvider(workspaceRoot);
      for (const command of [
        ['sh', '-c', 'id'],
        ['node', '-e', "require('child_process').execSync('id')"],
        ['npm', 'install'],
        ['node', '--test', '--', '; rm -rf /'],
      ]) {
        await expect(provider.execute({ workspacePath: taskWorkspace.path, command, limits: liveLimits })).rejects.toThrow(/not allowed/);
      }
      expect(createdContainerNames).toEqual([]);
    } finally {
      removeTaskWorkspace(workspaceRoot, taskWorkspace.path);
    }
  });

  it('removes a container whose creation races a cancellation instead of leaving it created', async () => {
    const root = fixtureRoot();
    const repository = writeRepository(root, "import test from 'node:test'; test('fixture only', () => {});");
    const workspaceRoot = path.join(root, 'task-workspaces');
    const taskWorkspace = await createTaskWorkspace({ repositoryPath: repository, workspaceRoot, taskId: `race-${Date.now()}`, allowedRoots: [repository] });
    const cancellation = new AbortController();
    // Abort in the same tick `docker run` is spawned, before the daemon can have created the container
    const provider = new DockerSandboxProvider({ image: image!, workspaceRoot }, (executable, args, options) => {
      const run = spawnDockerProcess(executable, args, options);
      if (args[0] === 'run' && options.containerName) {
        createdContainerNames.push(options.containerName);
        cancellation.abort();
      }
      return run;
    });
    try {
      const result = await provider.execute({ workspacePath: taskWorkspace.path, command: ['node', '--test'], limits: liveLimits, signal: cancellation.signal });
      expect(result.cancelled).toBe(true);
      const name = createdContainerNames.at(-1)!;
      await expectContainerRemoved(name);
      // A late create must not reappear after the provider reported cancellation
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect((await inspector('docker', ['inspect', '--format', '{{.State.Status}}', name])).exitCode).not.toBe(0);
    } finally {
      removeTaskWorkspace(workspaceRoot, taskWorkspace.path);
    }
  }, 30_000);

  it('reaps a never-started container of a dead worker and leaves live-owner and unlabelled containers', async () => {
    const root = fixtureRoot();
    const host = workspaceHostToken();
    const deadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid!;
    const liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    interruptedWorkerChildren.push(liveChild);
    const name = () => `asea-sbx-${randomUUID().replace(/-/g, '')}`;
    const create = async (containerName: string, labels: string[]) => {
      createdContainerNames.push(containerName);
      // `docker create` never starts the container, like a create that raced a stop
      const created = await inspector('docker', ['create', '--pull=never', '--network=none', '--name', containerName, ...labels, image!, 'true'], 15_000);
      expect(created.exitCode, created.stderr).toBe(0);
    };
    const owned = (pid: number) => ['--label=io.asea.sandbox=v1', `--label=io.asea.sandbox.host=${host}`, `--label=io.asea.sandbox.pid=${pid}`];
    const dead = name(); const live = name(); const unlabelled = name(); const otherHost = name();
    await create(dead, owned(deadPid));
    await create(live, owned(liveChild.pid!));
    await create(unlabelled, []);
    await create(otherHost, ['--label=io.asea.sandbox=v1', '--label=io.asea.sandbox.host=00000000', `--label=io.asea.sandbox.pid=${deadPid}`]);

    const result = await liveProvider(path.join(root, 'unused-workspaces')).reapAbandonedContainers();

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    await expectContainerRemoved(dead);
    for (const kept of [live, unlabelled, otherHost]) {
      expect((await inspector('docker', ['inspect', '--format', '{{.State.Status}}', kept])).stdout.trim()).toBe('created');
    }
  }, 60_000);

  it('cleans a sandbox after an abrupt worker-process interruption using its in-container deadline', async () => {
    const root = fixtureRoot();
    const workspaceRoot = path.join(root, 'worker-workspaces');
    const repository = path.join(root, 'repository');
    fs.mkdirSync(repository, { recursive: true });
    fs.writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(repository, 'fixture.test.js'), `import test from 'node:test'; test('keeps running', async () => await new Promise(resolve => setTimeout(resolve, 30000)));`);
    const readyFile = path.join(root, 'container-name.txt');
    const repositoryRoot = path.resolve(process.cwd(), '../..');
    const tsxCli = path.join(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');
    const helper = path.join(repositoryRoot, 'services/api/tests/engineering/fixtures/sandboxWorkerChild.ts');
    const child = spawn(process.execPath, [tsxCli, helper, image!, repository, workspaceRoot, readyFile], { cwd: repositoryRoot, windowsHide: true, stdio: 'ignore' });
    interruptedWorkerChildren.push(child);
    let runtime: { containerName: string; workspacePath: string; ownerPid: number } | undefined;
    const readyDeadline = Date.now() + 20_000;
    while (Date.now() < readyDeadline) {
      if (fs.existsSync(readyFile)) {
        runtime = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as typeof runtime;
        if (!createdContainerNames.includes(runtime!.containerName)) createdContainerNames.push(runtime!.containerName);
        const state = await inspector('docker', ['inspect', '--format', '{{.State.Running}}', runtime!.containerName]);
        if (state.exitCode === 0 && state.stdout.trim() === 'true') break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!runtime) throw new Error('Interrupted worker did not create a sandbox container.');

    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    const goneDeadline = Date.now() + 15_000;
    let gone = false;
    while (Date.now() < goneDeadline) {
      const result = await inspector('docker', ['inspect', '--format', '{{.State.Status}}', runtime.containerName]);
      if (result.exitCode !== 0) { gone = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(gone).toBe(true);
    expect(fs.existsSync(runtime.workspacePath)).toBe(true);
    const reaped = cleanupAbandonedTaskWorkspaces(workspaceRoot);
    expect(reaped).toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(runtime.workspacePath)).toBe(false);
  }, 45_000);
});
