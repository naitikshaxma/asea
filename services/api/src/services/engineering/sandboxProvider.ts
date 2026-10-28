export interface SandboxLimits {
  timeoutMs: number;
  memoryMb: number;
  cpuCount: number;
  maxProcesses: number;
  maxOutputBytes: number;
  /** Maximum writable bytes available to one test-command container. */
  workspaceSizeMb?: number;
  network: 'disabled';
}

export interface SandboxCommandRequest {
  workspacePath: string;
  workspaceReadOnly?: boolean;
  command: string[];
  limits: SandboxLimits;
  signal?: AbortSignal;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
}

export interface SandboxDiagnostics {
  provider: 'docker' | 'unavailable';
  status: 'READY' | 'UNAVAILABLE';
  image: string | null;
  reasonCode: 'NOT_CONFIGURED' | 'ENGINE_UNAVAILABLE' | 'IMAGE_MISSING' | null;
  message: string;
}

export interface SandboxProvider {
  /** True means a provider is configured; diagnose() confirms the runtime and image. */
  readonly available: boolean;
  diagnose(): Promise<SandboxDiagnostics>;
  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
}

export class SandboxUnavailableError extends Error {
  constructor(message = 'Sandbox execution is unavailable: no isolated execution provider is configured') {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

export function createUnavailableSandboxProvider(input: {
  reasonCode: 'NOT_CONFIGURED' | 'ENGINE_UNAVAILABLE' | 'IMAGE_MISSING';
  message: string;
  image?: string | null;
}): SandboxProvider {
  return {
    available: false,
    async diagnose(): Promise<SandboxDiagnostics> {
      return { provider: 'unavailable', status: 'UNAVAILABLE', image: input.image ?? null, reasonCode: input.reasonCode, message: input.message };
    },
    async execute(): Promise<SandboxCommandResult> {
      throw new SandboxUnavailableError(input.message);
    },
  };
}

export const unavailableSandboxProvider: SandboxProvider = {
  available: false,
  async diagnose(): Promise<SandboxDiagnostics> {
    return {
      provider: 'unavailable', status: 'UNAVAILABLE', image: null,
      reasonCode: 'NOT_CONFIGURED', message: 'No isolated execution provider is configured.',
    };
  },
  async execute(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    throw new SandboxUnavailableError();
  },
};
