import { assertAllowedSandboxCommand, detectTestCommands } from './executionPolicy.js';
import { SandboxUnavailableError, type SandboxCommandResult, type SandboxLimits, type SandboxProvider } from './sandboxProvider.js';
import { redactOutputPair, redactSensitiveText } from './outputRedaction.js';

export type TestRunStatus = 'PASSED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | 'NOT_RUN';

export interface TestCommandResult {
  name: string;
  command: string[];
  status: TestRunStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  summary: string;
}

export interface TestExecutionReport {
  status: TestRunStatus;
  detectedCommands: string[][];
  commands: TestCommandResult[];
  reason: string | null;
}

function statusOf(result: SandboxCommandResult): TestRunStatus {
  if (result.cancelled) return 'CANCELLED';
  if (result.timedOut) return 'TIMED_OUT';
  if (result.exitCode === 0 && !result.outputTruncated) return 'PASSED';
  return 'FAILED';
}

function summaryOf(status: TestRunStatus, result: SandboxCommandResult): string {
  if (status === 'PASSED') {
    const text = `${result.stdout}\n${result.stderr}`;
    const count = text.match(/(\d+\s+(?:passed|tests?\s+passed|passing))/i)?.[1];
    return count ? `Completed successfully (${count}).` : 'Test process exited with code 0.';
  }
  if (status === 'TIMED_OUT') return 'Test process exceeded the configured time limit and was terminated.';
  if (status === 'CANCELLED') return 'Test process was cancelled and terminated.';
  if (result.outputTruncated) return 'Test output exceeded its configured limit; the sandbox process was terminated.';
  return `Test process exited with code ${String(result.exitCode)}.`;
}

function notRun(reason: string, detectedCommands: string[][] = []): TestExecutionReport {
  return { status: 'NOT_RUN', detectedCommands, commands: [], reason: redactSensitiveText(reason, { maxBytes: 500 }) };
}

/** Runs only manifest-detected test commands approved by executionPolicy inside the configured sandbox. */
export async function runRepositoryTests(input: {
  workspacePath: string;
  provider: SandboxProvider;
  limits: SandboxLimits;
  signal?: AbortSignal;
}): Promise<TestExecutionReport> {
  if (input.signal?.aborted) return { status: 'CANCELLED', detectedCommands: [], commands: [], reason: 'Task cancellation was requested.' };
  let detected: ReturnType<typeof detectTestCommands>;
  try { detected = detectTestCommands(input.workspacePath); }
  catch { return notRun('Could not inspect test configuration in the disposable snapshot.'); }
  if (!detected.commands.length) return notRun(detected.reason ?? 'No supported tests were detected.');
  if (!input.provider.available) return notRun('No isolated sandbox provider is configured.', detected.commands.map((item) => item.command));
  try {
    const diagnostics = await input.provider.diagnose();
    if (diagnostics.status !== 'READY') return notRun(diagnostics.message, detected.commands.map((item) => item.command));
  } catch {
    return notRun('Sandbox runtime diagnostics failed; no repository command was run.', detected.commands.map((item) => item.command));
  }

  const results: TestCommandResult[] = [];
  for (const item of detected.commands) {
    if (input.signal?.aborted) return { status: 'CANCELLED', detectedCommands: detected.commands.map((entry) => entry.command), commands: results, reason: 'Task cancellation was requested.' };
    try {
      assertAllowedSandboxCommand(item.command);
      const execution = await input.provider.execute({ workspacePath: input.workspacePath, command: item.command, limits: input.limits, signal: input.signal });
      const safeOutput = redactOutputPair(execution.stdout, execution.stderr, input.limits.maxOutputBytes, execution.outputTruncated);
      const safeExecution = { ...execution, ...safeOutput };
      const status = statusOf(safeExecution);
      results.push({
        name: item.name, command: item.command, status, exitCode: safeExecution.exitCode,
        durationMs: safeExecution.durationMs, stdout: safeExecution.stdout, stderr: safeExecution.stderr,
        outputTruncated: safeExecution.outputTruncated, summary: summaryOf(status, safeExecution),
      });
      if (status !== 'PASSED') break;
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        return { ...notRun(error.message, detected.commands.map((entry) => entry.command)), commands: results };
      }
      const message = error instanceof Error ? error.message : 'Sandbox execution failed before a result was returned.';
      results.push({
        name: item.name, command: item.command, status: 'NOT_RUN', exitCode: null, durationMs: 0,
        stdout: '', stderr: '', outputTruncated: false,
        summary: redactSensitiveText(message, { maxBytes: 300 }),
      });
      break;
    }
  }

  const status = results.length === detected.commands.length && results.every((result) => result.status === 'PASSED')
    ? 'PASSED'
    : results.find((result) => result.status === 'CANCELLED')?.status
      ?? results.find((result) => result.status === 'TIMED_OUT')?.status
      ?? results.find((result) => result.status === 'FAILED')?.status
      ?? 'NOT_RUN';
  return { status, detectedCommands: detected.commands.map((item) => item.command), commands: results, reason: null };
}
