import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRepositoryTests, type TestRunStatus } from '../../src/services/engineering/testRunner.js';
import { runSecurityScans } from '../../src/services/engineering/securityScanner.js';
import type { SandboxCommandRequest, SandboxCommandResult, SandboxDiagnostics, SandboxProvider } from '../../src/services/engineering/sandboxProvider.js';

afterEach(() => vi.unstubAllEnvs());

const limits = { timeoutMs: 1000, memoryMb: 128, cpuCount: 1, maxProcesses: 16, maxOutputBytes: 4096, network: 'disabled' as const };
const result = (overrides: Partial<SandboxCommandResult> = {}): SandboxCommandResult => ({
  exitCode: 0, stdout: '', stderr: '', durationMs: 12, timedOut: false, cancelled: false, outputTruncated: false, ...overrides,
});
function createScanWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asea-security-scan-'));
}

class ScriptedSandbox implements SandboxProvider {
  readonly available = true;
  readonly calls: SandboxCommandRequest[] = [];
  constructor(private readonly respond: (request: SandboxCommandRequest) => SandboxCommandResult) {}
  async diagnose(): Promise<SandboxDiagnostics> {
    return { provider: 'docker', status: 'READY', image: 'asea/sandbox:test', reasonCode: null, message: 'ready' };
  }
  async execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.calls.push(request);
    return this.respond(request);
  }
}

describe('repository test runner', () => {
  it.each<[string, TestRunStatus, Partial<SandboxCommandResult>]>([
    ['passed', 'PASSED', { exitCode: 0, stdout: '1 test passed' }],
    ['failed', 'FAILED', { exitCode: 1, stderr: 'assertion failed' }],
    ['timed out', 'TIMED_OUT', { exitCode: null, timedOut: true }],
    ['cancelled', 'CANCELLED', { exitCode: null, cancelled: true }],
  ])('records a %s command outcome from the sandbox result', async (_label, status, execution) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-test-runner-'));
    try {
      fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      const sandbox = new ScriptedSandbox(() => result(execution));
      const report = await runRepositoryTests({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe(status);
      expect(report.commands[0]).toMatchObject({ command: ['node', '--test'], status, durationMs: 12 });
      expect(sandbox.calls[0]?.limits.network).toBe('disabled');
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('does not execute a manifest script when no supported tests are declared', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-test-runner-'));
    try {
      fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { build: 'node malicious.js' } }));
      const sandbox = new ScriptedSandbox(() => result());
      const report = await runRepositoryTests({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe('NOT_RUN');
      expect(sandbox.calls).toHaveLength(0);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('redacts stdout, stderr, assertion output and configured secrets before building the report', async () => {
    const secret = 'ASEA_RUNNER_SYNTHETIC_SECRET_87c321ab';
    vi.stubEnv('ASEA_RUNNER_TEST_SECRET', secret);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-test-redaction-'));
    try {
      fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      const sandbox = new ScriptedSandbox(() => result({
        exitCode: 1,
        stdout: `TAP output printed ${secret}`,
        stderr: `AssertionError: expected ${secret}; API_TOKEN=fixture-token-value-123`,
      }));
      const report = await runRepositoryTests({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe('FAILED');
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(JSON.stringify(report)).not.toContain('fixture-token-value-123');
      expect(JSON.stringify(report)).toContain('[REDACTED]');
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('redacts exception messages from a provider before they become persisted test evidence', async () => {
    const secret = 'ASEA_EXCEPTION_SYNTHETIC_SECRET_91f23abc';
    vi.stubEnv('ASEA_EXCEPTION_TEST_SECRET', secret);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-test-exception-'));
    try {
      fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      const sandbox: SandboxProvider = {
        available: true,
        async diagnose() { return { provider: 'docker', status: 'READY', image: 'asea/sandbox:test', reasonCode: null, message: 'ready' }; },
        async execute() { throw new Error(`Sandbox error included ${secret}`); },
      };
      const report = await runRepositoryTests({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe('NOT_RUN');
      expect(JSON.stringify(report)).not.toContain(secret);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('marks output exceeding the post-redaction byte budget as a failure', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-test-output-limit-'));
    try {
      fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      const sandbox = new ScriptedSandbox(() => result({ stdout: 'x'.repeat(2048) }));
      const report = await runRepositoryTests({ workspacePath: workspace, provider: sandbox, limits: { ...limits, maxOutputBytes: 1024 } });
      expect(report.status).toBe('FAILED');
      expect(report.commands[0]?.outputTruncated).toBe(true);
      expect(Buffer.byteLength(report.commands[0]?.stdout ?? '') + Buffer.byteLength(report.commands[0]?.stderr ?? '')).toBeLessThanOrEqual(1024);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });
});

describe('security scanner result handling', () => {
  const cleanReport = (command: string[]) => {
    if (command.includes('version') || command.includes('--version')) return result({ stdout: `${command[0]} test-version` });
    if (command[0] === 'gitleaks') return result({ stdout: '[]' });
    return result({ stdout: JSON.stringify({ results: [] }) });
  };

  it('requires all scanners to execute and preserves their names and versions', async () => {
    const sandbox = new ScriptedSandbox((request) => cleanReport(request.command));
    const workspace = createScanWorkspace();
    try {
      const report = await runSecurityScans({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status, JSON.stringify(report)).toBe('PASSED');
      expect(report.tools.map((tool) => tool.scanner)).toEqual(['gitleaks', 'semgrep', 'osv-scanner']);
      expect(report.tools.every((tool) => tool.version)).toBe(true);
      expect(sandbox.calls.every((call) => call.workspaceReadOnly === true)).toBe(true);
      expect(sandbox.calls.find((call) => call.command[0] === 'gitleaks' && call.command.includes('dir'))?.command).toContain('--config=/opt/asea/gitleaks.toml');
      expect(sandbox.calls.find((call) => call.command[0] === 'osv-scanner' && call.command.includes('scan'))?.command).toContain('--config=/opt/asea/osv-scanner.toml');
      expect(sandbox.calls.find((call) => call.command[0] === 'osv-scanner' && call.command.includes('--version'))?.command).toEqual(['osv-scanner', '--version']);
      expect(sandbox.calls.find((call) => call.command[0] === 'semgrep' && call.command.includes('scan'))?.command).toContain('--disable-nosem');
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('records findings without persisting Gitleaks matched secret text', async () => {
    const secret = 'ghp_0123456789abcdefghijklmnop';
    const sandbox = new ScriptedSandbox((request) => {
      if (request.command.includes('version') || request.command.includes('--version')) return result({ stdout: 'version' });
      if (request.command[0] === 'gitleaks') return result({ stdout: JSON.stringify([{ RuleID: 'token', Description: 'Possible credential', File: 'src/a.ts', StartLine: 4, Secret: secret, Match: secret }]) });
      return result({ stdout: JSON.stringify({ results: [] }) });
    });
    const workspace = createScanWorkspace();
    try {
      const report = await runSecurityScans({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe('FAILED');
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(report.tools[0]?.findings[0]).toMatchObject({ id: 'token', path: 'src/a.ts', line: 4 });
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('redacts secret-bearing scanner messages and keeps failed scans failed', async () => {
    const secret = 'ASEA_SCANNER_SYNTHETIC_SECRET_4567abcd';
    vi.stubEnv('ASEA_SCANNER_TEST_SECRET', secret);
    const sandbox = new ScriptedSandbox((request) => {
      if (request.command.includes('version') || request.command.includes('--version')) return result({ stdout: 'version' });
      if (request.command[0] === 'semgrep') return result({ stdout: JSON.stringify({ results: [{
        check_id: 'fixture.secret', path: 'src/example.ts', start: { line: 8 },
        extra: { severity: 'ERROR', message: `API_TOKEN=${secret}` },
      }] }) });
      return cleanReport(request.command);
    });
    const workspace = createScanWorkspace();
    try {
      const report = await runSecurityScans({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe('FAILED');
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(report.tools.find((tool) => tool.scanner === 'semgrep')?.findings[0]?.message).toContain('[REDACTED]');
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('distinguishes a missing scanner from a clean scan', async () => {
    const sandbox = new ScriptedSandbox((request) => request.command[0] === 'semgrep' && request.command.includes('--version')
      ? result({ exitCode: 127, stderr: 'not installed' }) : cleanReport(request.command));
    const workspace = createScanWorkspace();
    try {
      const report = await runSecurityScans({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe('UNAVAILABLE');
      expect(report.tools.find((tool) => tool.scanner === 'semgrep')?.status).toBe('UNAVAILABLE');
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('does not let repository Semgrep ignore files produce a clean scan', async () => {
    const workspace = createScanWorkspace();
    fs.writeFileSync(path.join(workspace, '.semgrepignore'), '*');
    const sandbox = new ScriptedSandbox((request) => cleanReport(request.command));
    try {
      const report = await runSecurityScans({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe('UNAVAILABLE');
      expect(report.tools.find((tool) => tool.scanner === 'semgrep')).toMatchObject({
        status: 'UNAVAILABLE', summary: expect.stringContaining('.semgrepignore'),
      });
      expect(sandbox.calls.some((call) => call.command[0] === 'semgrep')).toBe(false);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('preserves vulnerability evidence when OSV exits nonzero because it found an advisory', async () => {
    const workspace = createScanWorkspace();
    const sandbox = new ScriptedSandbox((request) => {
      if (request.command.includes('version') || request.command.includes('--version')) return result({ stdout: 'version' });
      if (request.command[0] === 'osv-scanner') return result({ exitCode: 1, stdout: JSON.stringify({ results: [{
        source: { path: 'package-lock.json' }, packages: [{ package: { name: 'example', version: '1.0.0' }, vulnerabilities: [{ id: 'GHSA-1234', summary: 'Affected package' }] }],
      }] }) });
      return cleanReport(request.command);
    });
    try {
      const report = await runSecurityScans({ workspacePath: workspace, provider: sandbox, limits });
      expect(report.status).toBe('FAILED');
      expect(report.tools.find((tool) => tool.scanner === 'osv-scanner')?.findings).toMatchObject([
        { id: 'GHSA-1234', path: 'package-lock.json', message: 'example: Affected package' },
      ]);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });
});
