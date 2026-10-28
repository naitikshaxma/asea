import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { SandboxCommandRequest, SandboxCommandResult, SandboxDiagnostics, SandboxLimits, SandboxProvider } from './sandboxProvider.js';
import { assertAllowedSandboxCommand } from './executionPolicy.js';
import { redactOutputPair } from './outputRedaction.js';
import { processIsAlive, workspaceHostToken } from './taskWorkspace.js';

// Ownership labels on every sandbox container. Startup recovery removes a
// container only when all of them match this host and a dead worker PID.
const OWNER_LABEL = 'io.asea.sandbox';
const OWNER_LABEL_VERSION = 'v1';
const HOST_LABEL = 'io.asea.sandbox.host';
const PID_LABEL = 'io.asea.sandbox.pid';
const CONTAINER_NAME = /^asea-sbx-[a-f0-9]{32}$/;

export interface AbandonedContainerCleanupResult {
  removed: number;
  failed: number;
}

interface DockerProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
}

interface DockerProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  containerName?: string;
}

export type DockerProcessExecutor = (
  executable: string,
  args: string[],
  options: DockerProcessOptions,
) => Promise<DockerProcessResult>;

function appendBounded(chunks: Buffer[], value: Buffer, remaining: number): { remaining: number; truncated: boolean } {
  if (remaining <= 0) return { remaining: 0, truncated: value.length > 0 };
  const accepted = value.subarray(0, remaining);
  chunks.push(accepted);
  return { remaining: remaining - accepted.length, truncated: value.length > accepted.length };
}

export function spawnDockerProcess(executable: string, args: string[], options: DockerProcessOptions): Promise<DockerProcessResult> {
  const startedAt = Date.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let remaining = Math.max(1024, Math.min(options.maxOutputBytes, 2 * 1024 * 1024));
  let outputTruncated = false;
  let timedOut = false;
  let cancelled = false;
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let removalRetry: ReturnType<typeof setTimeout> | undefined;
  let child: ChildProcessByStdio<null, Readable, Readable>;
  let resolvePromise!: (result: DockerProcessResult) => void;

  const promise = new Promise<DockerProcessResult>((resolve) => { resolvePromise = resolve; });
  if (options.signal?.aborted) {
    return Promise.resolve({ exitCode: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, cancelled: true, outputTruncated: false });
  }

  const cleanupContainer = () => {
    if (!options.containerName) {
      try { child.kill(); } catch { /* process may already have exited */ }
      return;
    }
    const containerName = options.containerName;
    // A stop can arrive before the daemon has created the container. Killing
    // the CLI then would leave it created but never started or removed, so the
    // removal is retried until it succeeds (the CLI then exits on its own) or
    // the deadline passes; only then is the CLI killed. `rm --force` exits 0
    // for a missing container, so success is the name it prints on removal.
    const removalDeadline = Date.now() + 10_000;
    const attemptRemoval = () => {
      removalRetry = undefined;
      try {
        const remover = spawn(executable, ['rm', '--force', containerName], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let printed = '';
        remover.stdout.on('data', (chunk: Buffer) => { if (printed.length < 256) printed += chunk.toString('utf8'); });
        remover.once('error', () => { try { child.kill(); } catch { /* already exited */ } });
        remover.once('close', () => {
          const removed = printed.split(/\r?\n/).some((line) => line.trim() === containerName);
          if (!removed && !finished && Date.now() < removalDeadline) {
            removalRetry = setTimeout(attemptRemoval, 250);
            return;
          }
          try { child.kill(); } catch { /* already exited */ }
        });
      } catch {
        try { child.kill(); } catch { /* best effort */ }
      }
    };
    attemptRemoval();
    forceKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* best effort */ } }, 12_500);
  };

  const finish = (exitCode: number | null) => {
    if (finished) return;
    finished = true;
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    if (removalRetry) clearTimeout(removalRetry);
    options.signal?.removeEventListener('abort', onAbort);
    const safeOutput = redactOutputPair(
      Buffer.concat(stdout).toString('utf8'),
      Buffer.concat(stderr).toString('utf8'),
      options.maxOutputBytes,
      outputTruncated,
    );
    outputTruncated = safeOutput.outputTruncated;
    resolvePromise({
      exitCode: timedOut || cancelled || outputTruncated ? null : exitCode,
      stdout: safeOutput.stdout,
      stderr: safeOutput.stderr,
      durationMs: Date.now() - startedAt,
      timedOut,
      cancelled,
      outputTruncated,
    });
  };

  const stop = (reason: 'timeout' | 'cancel' | 'output') => {
    if (finished || timedOut || cancelled || outputTruncated) return;
    if (reason === 'timeout') timedOut = true;
    if (reason === 'cancel') cancelled = true;
    if (reason === 'output') outputTruncated = true;
    cleanupContainer();
  };
  const onAbort = () => stop('cancel');

  try {
    child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return Promise.resolve({ exitCode: 127, stdout: '', stderr: 'Sandbox runtime executable could not be started.', durationMs: Date.now() - startedAt, timedOut: false, cancelled: false, outputTruncated: false });
  }

  const collect = (chunks: Buffer[]) => (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const appended = appendBounded(chunks, value, remaining);
    remaining = appended.remaining;
    if (appended.truncated) stop('output');
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  child.once('error', () => finish(127));
  child.once('close', (code) => finish(code));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  timeout = setTimeout(() => stop('timeout'), Math.max(1000, Math.min(options.timeoutMs, 610_000)));
  if (options.signal?.aborted) onAbort();
  return promise;
}

function clamp(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`Invalid sandbox ${label}`);
  return Math.max(min, Math.min(Math.floor(value), max));
}

function clampLimits(limits: SandboxLimits): SandboxLimits {
  if (limits.network !== 'disabled') throw new Error('Sandbox network access must remain disabled');
  return {
    timeoutMs: clamp(limits.timeoutMs, 1000, 600_000, 'timeout'),
    memoryMb: clamp(limits.memoryMb, 128, 4096, 'memory limit'),
    cpuCount: clamp(limits.cpuCount, 1, 4, 'CPU limit'),
    maxProcesses: clamp(limits.maxProcesses, 16, 256, 'process limit'),
    maxOutputBytes: clamp(limits.maxOutputBytes, 1024, 2 * 1024 * 1024, 'output limit'),
    workspaceSizeMb: clamp(limits.workspaceSizeMb ?? 256, 64, 1024, 'workspace size limit'),
    network: 'disabled',
  };
}

function canonicalWorkspace(workspaceRootInput: string, workspacePathInput: string): { root: string; workspace: string } {
  const root = fs.realpathSync(workspaceRootInput);
  if (fs.lstatSync(workspacePathInput).isSymbolicLink()) throw new Error('Sandbox workspace may not be a symbolic link');
  const workspace = fs.realpathSync(workspacePathInput);
  const relative = path.relative(root, workspace);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.dirname(relative) !== '.') {
    throw new Error('Sandbox workspace must be one direct child of the configured workspace root');
  }
  if (!fs.statSync(workspace).isDirectory()) throw new Error('Sandbox workspace must be a directory');
  return { root, workspace };
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly available = true;
  private readonly docker: DockerProcessExecutor;

  constructor(
    private readonly config: { image: string; workspaceRoot: string; executable?: string; uid?: number; gid?: number },
    docker: DockerProcessExecutor = spawnDockerProcess,
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]{0,254}$/.test(config.image)) throw new Error('Invalid sandbox image reference');
    if (!config.workspaceRoot.trim()) throw new Error('Task workspace root is required for Docker sandbox execution');
    this.docker = docker;
  }

  async diagnose(): Promise<SandboxDiagnostics> {
    const executable = this.config.executable ?? 'docker';
    const engine = await this.docker(executable, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 3000, maxOutputBytes: 4096 });
    if (engine.exitCode !== 0 || engine.timedOut || engine.cancelled) {
      return { provider: 'docker', status: 'UNAVAILABLE', image: this.config.image, reasonCode: 'ENGINE_UNAVAILABLE', message: 'Docker Engine is not reachable from the worker process.' };
    }
    const image = await this.docker(executable, ['image', 'inspect', '--format', '{{.Id}}', this.config.image], { timeoutMs: 3000, maxOutputBytes: 4096 });
    if (image.exitCode !== 0) {
      return { provider: 'docker', status: 'UNAVAILABLE', image: this.config.image, reasonCode: 'IMAGE_MISSING', message: 'The configured sandbox image is not present locally; automatic pulls are disabled.' };
    }
    return { provider: 'docker', status: 'READY', image: this.config.image, reasonCode: null, message: `Docker Engine is reachable and image ${this.config.image} is available locally.` };
  }

  /**
   * Removes sandbox containers left by a worker process that died, e.g. one
   * created after a stop's `docker rm` raced the daemon's create. Ownership is
   * proven by the labels, the generated name, this host's token and a PID probe;
   * unlabelled, other-host and live-owner containers are never touched.
   */
  async reapAbandonedContainers(isOwnerProcessAlive: (pid: number) => boolean = processIsAlive): Promise<AbandonedContainerCleanupResult> {
    const executable = this.config.executable ?? 'docker';
    const listed = await this.docker(executable, [
      'ps', '--all', '--no-trunc',
      '--filter', `label=${OWNER_LABEL}=${OWNER_LABEL_VERSION}`,
      '--filter', `label=${HOST_LABEL}=${workspaceHostToken()}`,
      '--format', `{{.ID}}|{{.Names}}|{{.Label "${HOST_LABEL}"}}|{{.Label "${PID_LABEL}"}}`,
    ], { timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
    if (listed.exitCode !== 0 || listed.outputTruncated) throw new Error('Could not list sandbox containers');
    const result: AbandonedContainerCleanupResult = { removed: 0, failed: 0 };
    for (const line of listed.stdout.split(/\r?\n/)) {
      const [id, name, host, pidLabel] = line.trim().split('|');
      if (!id || !/^[a-f0-9]{64}$/.test(id) || !name || !CONTAINER_NAME.test(name) || host !== workspaceHostToken()) continue;
      if (!pidLabel || !/^\d{1,10}$/.test(pidLabel)) continue;
      const ownerPid = Number(pidLabel);
      if (ownerPid <= 0 || ownerPid === process.pid || isOwnerProcessAlive(ownerPid)) continue;
      const removed = await this.docker(executable, ['rm', '--force', id], { timeoutMs: 10_000, maxOutputBytes: 4096 });
      if (removed.exitCode === 0) result.removed += 1;
      else result.failed += 1;
    }
    return result;
  }

  async execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    const { workspace } = canonicalWorkspace(this.config.workspaceRoot, request.workspacePath);
    assertAllowedSandboxCommand(request.command);
    const limits = clampLimits(request.limits);
    const hostPath = workspace.replace(/\\/g, '/');
    if (hostPath.includes(',')) throw new Error('Sandbox workspace paths containing commas are unsupported');
    const name = `asea-sbx-${randomUUID().replace(/-/g, '')}`;
    const commandTimeoutSeconds = Math.ceil(limits.timeoutMs / 1000);
    const boundedCommand = [
      'timeout', '--signal=TERM', '--kill-after=5s', `${commandTimeoutSeconds}s`,
      'sh', '-eu', '-c',
      'if [ -d /input ]; then cp -R /input/. /workspace/; fi; exec "$@"',
      'asea-sandbox', ...request.command,
    ];
    const workspaceMounts = request.workspaceReadOnly
      ? [`--mount=type=bind,source=${hostPath},target=/workspace,readonly`]
      : [
          `--mount=type=bind,source=${hostPath},target=/input,readonly`,
          `--tmpfs=/workspace:rw,nosuid,nodev,size=${limits.workspaceSizeMb! * 1024 * 1024},mode=1777`,
        ];
    const args = [
      'run', '--rm', '--pull=never', '--log-driver=none', '--name', name,
      `--label=${OWNER_LABEL}=${OWNER_LABEL_VERSION}`, `--label=${HOST_LABEL}=${workspaceHostToken()}`, `--label=${PID_LABEL}=${process.pid}`,
      '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--security-opt=seccomp=builtin',
      `--pids-limit=${limits.maxProcesses}`,
      `--memory=${limits.memoryMb}m`, `--memory-swap=${limits.memoryMb}m`, `--cpus=${limits.cpuCount}`,
      '--init', `--user=${this.config.uid ?? 1000}:${this.config.gid ?? 1000}`,
      '--shm-size=16m', '--tmpfs=/tmp:rw,noexec,nosuid,size=64m',
      ...workspaceMounts,
      '--workdir=/workspace', '--env=HOME=/tmp', '--env=CI=true',
      '--env=npm_config_offline=true', '--env=npm_config_ignore_scripts=true', '--env=PIP_NO_INDEX=1',
      this.config.image, ...boundedCommand,
    ];
    const result = await this.docker(this.config.executable ?? 'docker', args, {
      // The in-container GNU timeout keeps a container bounded even if the worker process exits.
      // This outer deadline leaves time for the container timeout and its kill grace to complete.
      timeoutMs: limits.timeoutMs + 6000,
      maxOutputBytes: limits.maxOutputBytes,
      signal: request.signal,
      containerName: name,
    });
    // GNU timeout reserves 124 for a command deadline. Treat that conservatively as timed out.
    const commandTimedOut = result.exitCode === 124;
    return commandTimedOut ? { ...result, exitCode: null, timedOut: true } : result;
  }
}
