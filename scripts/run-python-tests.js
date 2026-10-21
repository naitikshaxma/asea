import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const venvPytest = isWin
  ? join(process.cwd(), 'services', 'agent-service', '.venv', 'Scripts', 'pytest.exe')
  : join(process.cwd(), 'services', 'agent-service', '.venv', 'bin', 'pytest');

const testPath = join('services', 'agent-service', 'tests');

let cmd = 'pytest';
let args = [testPath];

if (existsSync(venvPytest)) {
  cmd = venvPytest;
} else {
  // Fall back to system python -m pytest
  cmd = isWin ? 'python' : 'python3';
  args = ['-m', 'pytest', testPath];
}

console.log(`Running Python tests with: ${cmd} ${args.join(' ')}`);
const result = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin });
process.exit(result.status ?? 0);
