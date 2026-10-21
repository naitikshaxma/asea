import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildArchitectureSummary } from '../../src/services/intelligence/architectureSummarizer.js';
import type { FileInventoryItem } from '@autonomous-engineer/contracts';

describe('Repository Intelligence: Architecture Summarizer', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-arch-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup
    }
  });

  it('detects entry points, modules, routes, services, models, and tests', () => {
    const files = [
      'src/server.ts',
      'src/routes/users.ts',
      'src/services/userService.ts',
      'src/models/user.ts',
      'prisma/schema.prisma',
      'tests/users.test.ts',
      'tsconfig.json',
    ];

    for (const rel of files) {
      const full = path.join(tempRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '// content');
    }

    const inventory: FileInventoryItem[] = files.map((p) => ({
      path: p,
      extension: path.extname(p),
      sizeBytes: 100,
      category: p.includes('test')
        ? 'TEST'
        : p.endsWith('.json')
        ? 'CONFIG'
        : 'SOURCE',
    }));

    const summary = buildArchitectureSummary(tempRoot, inventory);

    expect(summary.entryPoints).toContain('src/server.ts');
    expect(summary.apiRoutes.some((r) => r.path === 'src/routes/users.ts')).toBe(true);
    expect(summary.serviceLocations).toContain('src/services/userService.ts');
    expect(summary.modelLocations).toContain('prisma/schema.prisma');
    expect(summary.modelLocations).toContain('src/models/user.ts');
    expect(summary.testLocations).toContain('tests/users.test.ts');
    expect(summary.keyModules.length).toBeGreaterThanOrEqual(1);
    expect(summary.confidence).toBeGreaterThan(0.5);
  });

  it('statically extracts import and test relationships between files', () => {
    fs.mkdirSync(path.join(tempRoot, 'src/services'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'tests'), { recursive: true });

    const serviceCode = `
export class AuthService {
  login() { return true; }
}
`;
    const testCode = `
import { AuthService } from '../src/services/authService.js';
describe('Auth', () => {});
`;

    fs.writeFileSync(path.join(tempRoot, 'src/services/authService.ts'), serviceCode);
    fs.writeFileSync(path.join(tempRoot, 'tests/auth.test.ts'), testCode);

    const inventory: FileInventoryItem[] = [
      { path: 'src/services/authService.ts', extension: '.ts', sizeBytes: 100, category: 'SOURCE' },
      { path: 'tests/auth.test.ts', extension: '.ts', sizeBytes: 120, category: 'TEST' },
    ];

    const summary = buildArchitectureSummary(tempRoot, inventory);

    expect(summary.relationships.length).toBeGreaterThanOrEqual(1);
    const rel = summary.relationships[0];
    expect(rel?.sourceFile).toBe('tests/auth.test.ts');
    expect(rel?.relationshipType).toBe('TESTS');
    expect(rel?.targetFile).toBe('src/services/authService.ts');
  });
});
