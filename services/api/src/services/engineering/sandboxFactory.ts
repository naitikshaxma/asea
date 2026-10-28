import { config } from '../../config.js';
import { DockerSandboxProvider } from './dockerSandboxProvider.js';
import { createUnavailableSandboxProvider, unavailableSandboxProvider, type SandboxLimits, type SandboxProvider } from './sandboxProvider.js';

export function configuredSandboxProvider(): SandboxProvider {
  if (config.SANDBOX_PROVIDER !== 'docker') {
    return unavailableSandboxProvider;
  }
  if (!config.SANDBOX_DOCKER_IMAGE || !config.TASK_WORKSPACE_ROOT) {
    return createUnavailableSandboxProvider({
      reasonCode: 'NOT_CONFIGURED',
      image: config.SANDBOX_DOCKER_IMAGE ?? null,
      message: 'Docker sandbox requires SANDBOX_DOCKER_IMAGE and TASK_WORKSPACE_ROOT.',
    });
  }
  try {
    return new DockerSandboxProvider({
      image: config.SANDBOX_DOCKER_IMAGE,
      workspaceRoot: config.TASK_WORKSPACE_ROOT,
      executable: config.SANDBOX_DOCKER_EXECUTABLE,
      uid: config.SANDBOX_DOCKER_UID,
      gid: config.SANDBOX_DOCKER_GID,
    });
  } catch {
    return createUnavailableSandboxProvider({
      reasonCode: 'NOT_CONFIGURED', image: config.SANDBOX_DOCKER_IMAGE,
      message: 'Docker sandbox configuration is invalid.',
    });
  }
}

export function configuredSandboxLimits(): SandboxLimits {
  return {
    timeoutMs: config.SANDBOX_COMMAND_TIMEOUT_MS,
    memoryMb: config.SANDBOX_MEMORY_MB,
    cpuCount: config.SANDBOX_CPU_COUNT,
    maxProcesses: config.SANDBOX_MAX_PROCESSES,
    maxOutputBytes: config.SANDBOX_MAX_OUTPUT_BYTES,
    workspaceSizeMb: config.SANDBOX_WORKSPACE_SIZE_MB,
    network: 'disabled',
  };
}
