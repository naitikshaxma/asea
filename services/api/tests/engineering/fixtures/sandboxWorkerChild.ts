import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerSandboxProvider, spawnDockerProcess, type DockerProcessExecutor } from '../../../src/services/engineering/dockerSandboxProvider.js';
import { createTaskWorkspace } from '../../../src/services/engineering/taskWorkspace.js';

const [image, repositoryPath, workspaceRoot, readyFile] = process.argv.slice(2);
if (!image || !repositoryPath || !workspaceRoot || !readyFile) process.exit(2);

const runHash = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 40);
const hostToken = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8);
const taskId = `task-${runHash}-${hostToken}-${process.pid}-${randomUUID()}`;
const taskWorkspace = await createTaskWorkspace({ repositoryPath, workspaceRoot, taskId, allowedRoots: [repositoryPath] });

const executor: DockerProcessExecutor = (executable, args, options) => {
  const run = spawnDockerProcess(executable, args, options);
  if (options.containerName) fs.writeFileSync(readyFile, JSON.stringify({
    containerName: options.containerName,
    workspacePath: taskWorkspace.path,
    ownerPid: process.pid,
  }), { encoding: 'utf8', mode: 0o600 });
  return run;
};

const provider = new DockerSandboxProvider({ image, workspaceRoot }, executor);
await provider.execute({
  workspacePath: taskWorkspace.path,
  command: ['node', '--test'],
  limits: { timeoutMs: 5000, memoryMb: 512, cpuCount: 1, maxProcesses: 32, maxOutputBytes: 4096, workspaceSizeMb: 64, network: 'disabled' },
});
