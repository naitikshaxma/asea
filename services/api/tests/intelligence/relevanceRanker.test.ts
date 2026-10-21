import { describe, it, expect } from 'vitest';
import {
  extractTaskTokens,
  rankRelevantFiles,
} from '../../src/services/intelligence/relevanceRanker.js';
import type { ArchitectureSummary, FileInventoryItem } from '@autonomous-engineer/contracts';

describe('Repository Intelligence: Relevance Ranker', () => {
  it('extracts meaningful keyword tokens and splits camelCase', () => {
    const prompt = 'Investigate memory leak in authMiddleware and redisCache worker';
    const tokens = extractTaskTokens(prompt);

    expect(tokens).toContain('memory');
    expect(tokens).toContain('leak');
    expect(tokens).toContain('authmiddleware');
    expect(tokens).toContain('auth');
    expect(tokens).toContain('middleware');
    expect(tokens).toContain('rediscache');
    expect(tokens).toContain('redis');
    expect(tokens).toContain('cache');
    expect(tokens).toContain('worker');
    expect(tokens).not.toContain('in');
    expect(tokens).not.toContain('and');
  });

  it('ranks files matching basename and functional role highest with clear evidence', () => {
    const inventory: FileInventoryItem[] = [
      { path: 'src/middlewares/authMiddleware.ts', extension: '.ts', sizeBytes: 100, category: 'SOURCE' },
      { path: 'tests/authMiddleware.test.ts', extension: '.ts', sizeBytes: 150, category: 'TEST' },
      { path: 'src/services/authService.ts', extension: '.ts', sizeBytes: 200, category: 'SOURCE' },
      { path: 'src/components/UnrelatedButton.tsx', extension: '.tsx', sizeBytes: 80, category: 'SOURCE' },
      { path: 'README.md', extension: '.md', sizeBytes: 500, category: 'DOCUMENTATION' },
    ];

    const architecture: ArchitectureSummary = {
      repositoryOverview: 'Test overview',
      entryPoints: ['src/server.ts'],
      keyModules: [],
      apiRoutes: [],
      serviceLocations: ['src/services/authService.ts'],
      modelLocations: [],
      testFrameworks: ['Vitest'],
      testLocations: ['tests/authMiddleware.test.ts'],
      configurationLocations: [],
      relationships: [
        {
          sourceFile: 'tests/authMiddleware.test.ts',
          targetFile: 'src/middlewares/authMiddleware.ts',
          relationshipType: 'TESTS',
        },
      ],
      limitations: [],
      confidence: 1.0,
    };

    const results = rankRelevantFiles(
      'Fix token verification defect in authMiddleware',
      inventory,
      architecture,
      5
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]?.path).toBe('src/middlewares/authMiddleware.ts');
    expect(results[0]?.score).toBeGreaterThan(30);
    expect(results[0]?.reason).toContain('auth');
    expect(results[0]?.evidence.length).toBeGreaterThan(0);

    // Tests for authMiddleware should also score highly
    const testResult = results.find((r) => r.path === 'tests/authMiddleware.test.ts');
    expect(testResult).toBeDefined();
    expect(testResult?.suggestedAction).toContain('regression test');

    // Unrelated button should not be in top ranks
    const buttonResult = results.find((r) => r.path === 'src/components/UnrelatedButton.tsx');
    expect(buttonResult).toBeUndefined();
  });

  it('respects the requested limit', () => {
    const inventory: FileInventoryItem[] = [
      { path: 'src/auth1.ts', extension: '.ts', sizeBytes: 100, category: 'SOURCE' },
      { path: 'src/auth2.ts', extension: '.ts', sizeBytes: 100, category: 'SOURCE' },
      { path: 'src/auth3.ts', extension: '.ts', sizeBytes: 100, category: 'SOURCE' },
      { path: 'src/auth4.ts', extension: '.ts', sizeBytes: 100, category: 'SOURCE' },
    ];

    const architecture: ArchitectureSummary = {
      repositoryOverview: 'Test',
      entryPoints: [],
      keyModules: [],
      apiRoutes: [],
      serviceLocations: [],
      modelLocations: [],
      testFrameworks: [],
      testLocations: [],
      configurationLocations: [],
      relationships: [],
      limitations: [],
      confidence: 1.0,
    };

    const results = rankRelevantFiles('auth configuration', inventory, architecture, 2);
    expect(results.length).toBe(2);
  });
});
