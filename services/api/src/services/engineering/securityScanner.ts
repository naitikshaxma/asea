import { SandboxUnavailableError, type SandboxCommandResult, type SandboxLimits, type SandboxProvider } from './sandboxProvider.js';
import fs, { type Dirent } from 'node:fs';
import path from 'node:path';
import { redactSensitiveData, redactSensitiveText } from './outputRedaction.js';

export type SecurityScanStatus = 'PASSED' | 'FAILED' | 'UNAVAILABLE' | 'NOT_RUN';

export interface SecurityFinding {
  scanner: string;
  id: string;
  severity: string;
  path: string | null;
  line: number | null;
  message: string;
}

export interface SecurityToolResult {
  scanner: string;
  version: string | null;
  status: SecurityScanStatus;
  exitCode: number | null;
  durationMs: number;
  findings: SecurityFinding[];
  summary: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface SecurityExecutionReport {
  status: SecurityScanStatus;
  tools: SecurityToolResult[];
  coverage: string[];
  limitations: string[];
  reason: string | null;
}

const GITLEAKS = 'gitleaks';
const SEMGREP = 'semgrep';
const OSV = 'osv-scanner';
const MAX_FINDINGS = 500;
const MAX_IGNORE_CONFIG_SCAN_ENTRIES = 20_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeString(value: unknown, max = 500): string {
  return typeof value === 'string'
    ? redactSensitiveText(value.replace(/[\r\n\0]+/g, ' '), { maxBytes: max })
    : '';
}

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function gitleaksFindings(value: unknown): SecurityFinding[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, MAX_FINDINGS).map((item) => {
    const row = asRecord(item) ?? {};
    return {
      scanner: GITLEAKS,
      id: safeString(row.RuleID, 120) || 'secret-detection',
      severity: 'HIGH',
      path: safeString(row.File, 500) || null,
      line: Number.isSafeInteger(row.StartLine) ? Number(row.StartLine) : null,
      // Never store a secret value or the scanner's matched text.
      message: safeString(row.Description, 300) || 'Potential secret detected.',
    };
  });
}

function semgrepFindings(value: unknown): SecurityFinding[] | null {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.results)) return null;
  return root.results.slice(0, MAX_FINDINGS).map((item) => {
    const row = asRecord(item) ?? {};
    const extra = asRecord(row.extra) ?? {};
    const start = asRecord(row.start) ?? {};
    return {
      scanner: SEMGREP,
      id: safeString(row.check_id, 160) || 'static-analysis',
      severity: safeString(extra.severity, 24).toUpperCase() || 'WARNING',
      path: safeString(row.path, 500) || null,
      line: Number.isSafeInteger(start.line) ? Number(start.line) : null,
      message: safeString(extra.message, 500) || 'Static analysis finding.',
    };
  });
}

function osvFindings(value: unknown): SecurityFinding[] | null {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.results)) return null;
  const findings: SecurityFinding[] = [];
  for (const resultValue of root.results) {
    const result = asRecord(resultValue) ?? {};
    const source = asRecord(result.source) ?? {};
    const sourcePath = safeString(source.path, 500) || null;
    const packages = Array.isArray(result.packages) ? result.packages : [];
    for (const packageValue of packages) {
      const pkg = asRecord(packageValue) ?? {};
      const packageInfo = asRecord(pkg.package) ?? {};
      const packageName = safeString(packageInfo.name, 160) || 'dependency';
      const vulns = Array.isArray(pkg.vulnerabilities) ? pkg.vulnerabilities : [];
      for (const vulnValue of vulns) {
        const vuln = asRecord(vulnValue) ?? {};
        findings.push({
          scanner: OSV,
          id: safeString(vuln.id, 120) || 'dependency-vulnerability',
          severity: safeString(vuln.database_specific && asRecord(vuln.database_specific)?.severity, 24).toUpperCase() || 'UNKNOWN',
          path: sourcePath,
          line: null,
          message: `${packageName}: ${safeString(vuln.summary, 300) || 'Known vulnerability reported.'}`,
        });
        if (findings.length >= MAX_FINDINGS) return findings;
      }
    }
  }
  return findings;
}

function classifyExecution(result: SandboxCommandResult): SecurityScanStatus | 'EXECUTION_ERROR' {
  if (result.timedOut || result.cancelled || result.outputTruncated) return 'EXECUTION_ERROR';
  if (result.exitCode === 127) return 'UNAVAILABLE';
  if (result.exitCode !== 0) return 'EXECUTION_ERROR';
  return 'PASSED';
}

function unavailableTool(scanner: string, summary: string): SecurityToolResult {
  return { scanner, version: null, status: 'UNAVAILABLE', exitCode: null, durationMs: 0, findings: [], summary, stderr: '', outputTruncated: false };
}

/** Semgrep's repository ignore files can suppress the whole scan; do not mark that scan clean. */
function findSemgrepIgnoreConfig(rootInput: string): { path: string | null; complete: boolean } {
  const root = fs.realpathSync(rootInput);
  const pending = [root];
  let seen = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { return { path: null, complete: false }; }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_IGNORE_CONFIG_SCAN_ENTRIES) return { path: null, complete: false };
      if (entry.name === '.semgrepignore' && entry.isFile()) {
        return { path: path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/'), complete: true };
      }
      // Do not follow symlinks; snapshot construction materializes only bounded regular files.
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(directory, entry.name));
    }
  }
  return { path: null, complete: true };
}

async function scanWithTool(input: {
  workspacePath: string;
  provider: SandboxProvider;
  limits: SandboxLimits;
  signal?: AbortSignal;
  scanner: string;
  versionCommand: string[];
  scanCommand: string[];
  parseFindings: (value: unknown) => SecurityFinding[] | null;
}): Promise<SecurityToolResult> {
  let versionResult: SandboxCommandResult;
  try {
    versionResult = await input.provider.execute({ workspacePath: input.workspacePath, workspaceReadOnly: true, command: input.versionCommand, limits: input.limits, signal: input.signal });
  } catch (error) {
    return unavailableTool(input.scanner, error instanceof SandboxUnavailableError ? error.message : 'Scanner could not be started in the sandbox.');
  }
  if (versionResult.cancelled) {
    return { ...unavailableTool(input.scanner, 'Scanner execution was cancelled.'), status: 'NOT_RUN' };
  }
  if (classifyExecution(versionResult) !== 'PASSED') {
    return unavailableTool(input.scanner, `Scanner binary is unavailable or failed its version check (exit ${String(versionResult.exitCode)}).`);
  }
  const version = safeString(`${versionResult.stdout} ${versionResult.stderr}`, 120).trim() || null;

  let result: SandboxCommandResult;
  try {
    result = await input.provider.execute({ workspacePath: input.workspacePath, workspaceReadOnly: true, command: input.scanCommand, limits: input.limits, signal: input.signal });
  } catch (error) {
    return { ...unavailableTool(input.scanner, error instanceof SandboxUnavailableError ? error.message : 'Scanner execution was unavailable.'), version };
  }
  if (result.cancelled) {
    return { ...unavailableTool(input.scanner, 'Scanner execution was cancelled.'), version, status: 'NOT_RUN' };
  }
  if (result.timedOut || result.outputTruncated) {
    return {
      scanner: input.scanner, version, status: 'FAILED',
      exitCode: result.exitCode, durationMs: result.durationMs, findings: [],
      summary: result.timedOut ? 'Scanner timed out.' : 'Scanner output limit was exceeded.',
      stderr: result.stderr.slice(0, 4000), outputTruncated: result.outputTruncated,
    };
  }

  const parsed = input.parseFindings(parseJson(result.stdout));
  if (parsed === null) {
    return { scanner: input.scanner, version, status: 'FAILED', exitCode: result.exitCode, durationMs: result.durationMs,
      findings: [], summary: 'Scanner completed but did not return the expected JSON report.', stderr: result.stderr.slice(0, 4000), outputTruncated: result.outputTruncated };
  }
  if (result.exitCode === 127) return { ...unavailableTool(input.scanner, 'Scanner binary is unavailable.'), version };
  if (result.exitCode !== 0 && parsed.length === 0) {
    return { scanner: input.scanner, version, status: 'FAILED', exitCode: result.exitCode, durationMs: result.durationMs,
      findings: [], summary: `Scanner exited with code ${String(result.exitCode)} without parsed findings.`,
      stderr: result.stderr.slice(0, 4000), outputTruncated: result.outputTruncated };
  }
  return {
    scanner: input.scanner, version, status: parsed.length ? 'FAILED' : 'PASSED', exitCode: result.exitCode,
    durationMs: result.durationMs, findings: parsed,
    summary: parsed.length ? `${parsed.length} finding(s) reported.` : 'Scanner completed with no findings.',
    stderr: result.stderr.slice(0, 4000), outputTruncated: result.outputTruncated,
  };
}

/** Runs only pinned, local scanner commands. No repository-controlled scanner command or remote rule fetch is allowed. */
async function runSecurityScansInternal(input: {
  workspacePath: string;
  provider: SandboxProvider;
  limits: SandboxLimits;
  signal?: AbortSignal;
}): Promise<SecurityExecutionReport> {
  if (input.signal?.aborted) {
    return { status: 'NOT_RUN', tools: [], coverage: [], limitations: [], reason: 'Task cancellation was requested before scanning started.' };
  }
  if (!input.provider.available) {
    return { status: 'UNAVAILABLE', tools: [], coverage: [], limitations: ['No isolated sandbox provider is configured.'], reason: 'Security scanners did not run.' };
  }
  try {
    const diagnostics = await input.provider.diagnose();
    if (diagnostics.status !== 'READY') {
      return { status: 'UNAVAILABLE', tools: [], coverage: [], limitations: [diagnostics.message], reason: 'Security scanners did not run.' };
    }
  } catch {
    return { status: 'UNAVAILABLE', tools: [], coverage: [], limitations: ['Sandbox runtime diagnostics failed.'], reason: 'Security scanners did not run.' };
  }

  const common = { workspacePath: input.workspacePath, provider: input.provider, limits: input.limits, signal: input.signal };
  let semgrepIgnore: ReturnType<typeof findSemgrepIgnoreConfig>;
  try { semgrepIgnore = findSemgrepIgnoreConfig(input.workspacePath); }
  catch { semgrepIgnore = { path: null, complete: false }; }
  const semgrepResult = !semgrepIgnore.complete
    ? unavailableTool(SEMGREP, 'Could not safely inspect the bounded workspace for Semgrep ignore configuration.')
    : semgrepIgnore.path
      ? unavailableTool(SEMGREP, `Repository Semgrep ignore file prevents a trustworthy scan: ${semgrepIgnore.path}`)
      : null;
  const tools = await Promise.all([
    scanWithTool({ ...common, scanner: GITLEAKS, versionCommand: ['gitleaks', 'version'],
      scanCommand: ['gitleaks', 'dir', '/workspace', '--config=/opt/asea/gitleaks.toml', '--gitleaks-ignore-path=/opt/asea/empty-gitleaks-ignore', '--ignore-gitleaks-allow', '--redact', '--no-banner', '--report-format=json', '--report-path=-', '--exit-code=0', '--log-level=fatal'],
      parseFindings: gitleaksFindings }),
    semgrepResult ? Promise.resolve(semgrepResult) : scanWithTool({ ...common, scanner: SEMGREP, versionCommand: ['semgrep', '--version'],
      scanCommand: ['semgrep', 'scan', '--config=/opt/asea/semgrep-rules.yaml', '--json', '--no-git-ignore', '--disable-nosem', '--quiet', '/workspace'],
      parseFindings: semgrepFindings }),
    scanWithTool({ ...common, scanner: OSV, versionCommand: ['osv-scanner', '--version'],
      scanCommand: ['osv-scanner', 'scan', 'source', '--config=/opt/asea/osv-scanner.toml', '--offline-vulnerabilities', '--no-ignore', '--format=json', '--recursive', '/workspace'],
      parseFindings: osvFindings }),
  ]);

  const status: SecurityScanStatus = tools.some((tool) => tool.status === 'FAILED') ? 'FAILED'
    : input.signal?.aborted ? 'NOT_RUN'
      : tools.some((tool) => tool.status === 'UNAVAILABLE' || tool.status === 'NOT_RUN') ? 'UNAVAILABLE' : 'PASSED';
  return {
    status, tools,
    coverage: ['Gitleaks secret detection', 'Semgrep local static rules', 'OSV-Scanner offline dependency vulnerability lookup'],
    limitations: ['Findings depend on the configured scanner versions, local Semgrep rules, and the age/coverage of the embedded OSV database; a clean report is not a guarantee that code is secure.'],
    reason: status === 'PASSED' ? null : tools.filter((tool) => tool.status !== 'PASSED').map((tool) => `${tool.scanner}: ${tool.summary}`).join(' '),
  };
}

/** A final sanitizer protects all scanner evidence, including non-Docker test providers. */
export async function runSecurityScans(input: {
  workspacePath: string;
  provider: SandboxProvider;
  limits: SandboxLimits;
  signal?: AbortSignal;
}): Promise<SecurityExecutionReport> {
  return redactSensitiveData(await runSecurityScansInternal(input));
}
