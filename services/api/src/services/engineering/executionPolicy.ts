import fs from 'node:fs';
import path from 'node:path';

export type SupportedTestCommand = { name: string; command: string[] };

const FIXED_COMMANDS = new Set([
  'node --test',
  'python -m pytest -q',
  'npm --offline --ignore-scripts test',
  'npm --offline --ignore-scripts test -- --run',
  'npm --offline --ignore-scripts test -- --runInBand',
  'gitleaks dir /workspace --config=/opt/asea/gitleaks.toml --gitleaks-ignore-path=/opt/asea/empty-gitleaks-ignore --ignore-gitleaks-allow --redact --no-banner --report-format=json --report-path=- --exit-code=0 --log-level=fatal',
  'gitleaks version',
  'osv-scanner scan source --config=/opt/asea/osv-scanner.toml --offline-vulnerabilities --no-ignore --format=json --recursive /workspace',
  'osv-scanner --version',
  'semgrep --version',
  'semgrep scan --config=/opt/asea/semgrep-rules.yaml --json --no-git-ignore --disable-nosem --quiet /workspace',
]);

function commandKey(command: string[]): string {
  if (command.length > 16 || command.some((part) => typeof part !== 'string' || part.length > 512 || part.includes('\0'))) {
    throw new Error('Sandbox command exceeds the command policy limits');
  }
  return command.join(' ');
}

/** Repository content is never converted to a shell string; only these exact argv vectors are accepted. */
export function assertAllowedSandboxCommand(command: string[]): void {
  if (!Array.isArray(command) || command.length === 0) throw new Error('Sandbox command is empty');
  if (!FIXED_COMMANDS.has(commandKey(command))) throw new Error('Sandbox command is not allowed by the execution policy');
}

function regularFile(root: string, name: string, maxBytes = 1024 * 1024): string | null {
  const filePath = path.join(root, name);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(filePath);
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return filePath;
  } catch {
    return null;
  }
}

function readPackageJson(root: string): { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> } | null {
  const filePath = regularFile(root, 'package.json');
  if (!filePath) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

function hasPythonTestConfig(root: string): boolean {
  return ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg'].some((name) => Boolean(regularFile(root, name)));
}

/** Conservative, manifest-only detection. No repository scripts are executed during detection. */
export function detectTestCommands(workspacePath: string): { commands: SupportedTestCommand[]; reason: string | null } {
  const root = fs.realpathSync(workspacePath);
  if (!fs.statSync(root).isDirectory()) return { commands: [], reason: 'Task snapshot is not a directory.' };
  const commands: SupportedTestCommand[] = [];
  const packageJson = readPackageJson(root);
  const testScript = packageJson?.scripts?.['test'];
  if (typeof testScript === 'string' && testScript.trim()) {
    const declared = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
    const usesVitest = /\bvitest\b/i.test(testScript) || 'vitest' in declared;
    const usesJest = /\bjest\b/i.test(testScript) || 'jest' in declared;
    const nodeTest = /^node\s+--test(?:\s|$)/.test(testScript.trim());
    if (nodeTest) commands.push({ name: 'node:test', command: ['node', '--test'] });
    else if (usesVitest) commands.push({ name: 'vitest', command: ['npm', '--offline', '--ignore-scripts', 'test', '--', '--run'] });
    else if (usesJest) commands.push({ name: 'jest', command: ['npm', '--offline', '--ignore-scripts', 'test', '--', '--runInBand'] });
    else commands.push({ name: 'npm test script', command: ['npm', '--offline', '--ignore-scripts', 'test'] });
  }

  const hasPythonTests = fs.existsSync(path.join(root, 'tests')) || fs.existsSync(path.join(root, 'test'));
  if (hasPythonTests && hasPythonTestConfig(root) && commands.length < 2) {
    commands.push({ name: 'pytest', command: ['python', '-m', 'pytest', '-q'] });
  }
  return commands.length
    ? { commands: commands.slice(0, 2), reason: null }
    : { commands: [], reason: 'No supported test script and framework configuration were detected; no command was run.' };
}
