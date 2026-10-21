import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectTechnologies } from '../../src/services/intelligence/technologyDetector.js';
import type { FileInventoryItem } from '@autonomous-engineer/contracts';

describe('Repository Intelligence: Technology Detector', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-tech-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup
    }
  });

  it('detects Node.js, TypeScript, Express, React, Vite, Vitest, Prisma, and BullMQ from package.json', () => {
    const pkg = {
      name: 'test-app',
      engines: { node: '>=20.0.0' },
      dependencies: {
        express: '^4.21.0',
        react: '^18.3.0',
        '@prisma/client': '^6.0.0',
        bullmq: '^5.0.0',
        pg: '^8.13.0',
      },
      devDependencies: {
        typescript: '^5.7.0',
        vite: '^6.0.0',
        vitest: '^3.0.0',
      },
    };

    fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(tempRoot, 'tsconfig.json'), '{}');

    const inventory: FileInventoryItem[] = [
      { path: 'package.json', extension: '.json', sizeBytes: 500, category: 'CONFIG' },
      { path: 'tsconfig.json', extension: '.json', sizeBytes: 100, category: 'CONFIG' },
      { path: 'src/index.ts', extension: '.ts', sizeBytes: 200, category: 'SOURCE' },
    ];

    const findings = detectTechnologies(tempRoot, inventory);
    const names = findings.map((f) => f.name);

    expect(names).toContain('Node.js');
    expect(names).toContain('TypeScript');
    expect(names).toContain('Express.js');
    expect(names).toContain('React');
    expect(names).toContain('Vite');
    expect(names).toContain('Vitest');
    expect(names).toContain('Prisma ORM');
    expect(names).toContain('BullMQ');
    expect(names).toContain('PostgreSQL Driver');

    const nodeFinding = findings.find((f) => f.name === 'Node.js');
    expect(nodeFinding?.version).toBe('>=20.0.0');
    expect(nodeFinding?.evidenceFiles).toContain('package.json');
  });

  it('detects Python, FastAPI, Pydantic, and pytest from requirements.txt', () => {
    const requirementsTxt = `
fastapi>=0.115.0
pydantic>=2.0.0
pytest>=8.0.0
httpx>=0.28.0
`;
    fs.writeFileSync(path.join(tempRoot, 'requirements.txt'), requirementsTxt);

    const inventory: FileInventoryItem[] = [
      { path: 'requirements.txt', extension: '.txt', sizeBytes: 100, category: 'CONFIG' },
      { path: 'app/main.py', extension: '.py', sizeBytes: 300, category: 'SOURCE' },
    ];

    const findings = detectTechnologies(tempRoot, inventory);
    const names = findings.map((f) => f.name);

    expect(names).toContain('Python');
    expect(names).toContain('FastAPI');
    expect(names).toContain('Pydantic');
    expect(names).toContain('pytest');
  });

  it('detects Go module with version from go.mod', () => {
    const goMod = `
module github.com/example/app

go 1.22.4

require (
    github.com/gin-gonic/gin v1.9.1
)
`;
    fs.writeFileSync(path.join(tempRoot, 'go.mod'), goMod);

    const inventory: FileInventoryItem[] = [
      { path: 'go.mod', extension: '.mod', sizeBytes: 150, category: 'CONFIG' },
      { path: 'main.go', extension: '.go', sizeBytes: 400, category: 'SOURCE' },
    ];

    const findings = detectTechnologies(tempRoot, inventory);
    const goFinding = findings.find((f) => f.name === 'Go');

    expect(goFinding).toBeDefined();
    expect(goFinding?.version).toBe('1.22.4');
    expect(goFinding?.evidenceFiles).toContain('go.mod');
  });

  it('detects Docker containers from Dockerfile and compose.yaml', () => {
    fs.writeFileSync(path.join(tempRoot, 'Dockerfile'), 'FROM node:20-alpine\n');
    fs.writeFileSync(path.join(tempRoot, 'compose.yaml'), 'services:\n  web:\n');

    const inventory: FileInventoryItem[] = [
      { path: 'Dockerfile', extension: '', sizeBytes: 50, category: 'INFRASTRUCTURE' },
      { path: 'compose.yaml', extension: '.yaml', sizeBytes: 80, category: 'INFRASTRUCTURE' },
    ];

    const findings = detectTechnologies(tempRoot, inventory);
    const dockerFinding = findings.find((f) => f.name === 'Docker');

    expect(dockerFinding).toBeDefined();
    expect(dockerFinding?.evidenceFiles).toContain('Dockerfile');
    expect(dockerFinding?.evidenceFiles).toContain('compose.yaml');
  });

  it('handles malformed manifests gracefully without crashing', () => {
    fs.writeFileSync(path.join(tempRoot, 'package.json'), 'INVALID_JSON{{{');

    const inventory: FileInventoryItem[] = [
      { path: 'package.json', extension: '.json', sizeBytes: 20, category: 'CONFIG' },
    ];

    expect(() => detectTechnologies(tempRoot, inventory)).not.toThrow();
  });
});
