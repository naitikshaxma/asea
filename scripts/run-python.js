// Runs a Python script with the agent-service virtualenv's interpreter when it
// exists, otherwise the system Python. Usage: node scripts/run-python.js <script> [args...]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const venvPython = isWin
  ? join(process.cwd(), 'services', 'agent-service', '.venv', 'Scripts', 'python.exe')
  : join(process.cwd(), 'services', 'agent-service', '.venv', 'bin', 'python');
const python = existsSync(venvPython) ? venvPython : isWin ? 'python' : 'python3';

const result = spawnSync(python, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
