import fs from 'node:fs';
import path from 'node:path';
import type {
  ArchitectureSummary,
  FileInventoryItem,
  FileRelationship,
  KeyModule,
  ApiRouteLocation,
} from '@autonomous-engineer/contracts';

const ENTRY_POINT_CANDIDATES = [
  'src/server.ts',
  'src/server.js',
  'src/index.ts',
  'src/index.js',
  'src/main.ts',
  'src/main.js',
  'src/app.ts',
  'src/app.js',
  'server.ts',
  'server.js',
  'main.py',
  'app/main.py',
  'main.go',
  'cmd/main.go',
  'index.ts',
  'index.js',
  'app.ts',
  'app.js',
];

export function buildArchitectureSummary(
  repositoryRoot: string,
  inventory: FileInventoryItem[]
): ArchitectureSummary {
  const limitations: string[] = [];
  const relationships: FileRelationship[] = [];

  const eligibleFiles = inventory.filter((f) => !f.skippedReason);
  const normalizedPaths = eligibleFiles.map((f) => f.path.replace(/\\/g, '/'));
  const pathSet = new Set(normalizedPaths);

  // 1. Detect Entry Points
  const entryPoints: string[] = [];
  for (const candidate of ENTRY_POINT_CANDIDATES) {
    if (pathSet.has(candidate)) {
      entryPoints.push(candidate);
    }
  }

  // Also check for subpackage entry points e.g. services/api/src/server.ts
  for (const p of normalizedPaths) {
    const base = path.basename(p);
    if (
      (base === 'server.ts' ||
        base === 'server.js' ||
        base === 'main.py' ||
        base === 'main.ts' ||
        base === 'main.go') &&
      !entryPoints.includes(p)
    ) {
      entryPoints.push(p);
    }
  }

  // 2. Identify Key Modules / Functional Directories
  const dirCounts = new Map<string, number>();
  for (const f of eligibleFiles) {
    const dir = path.dirname(f.path).replace(/\\/g, '/');
    if (dir !== '.') {
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
    }
  }

  const keyModules: KeyModule[] = [];
  for (const [dirPath, count] of dirCounts.entries()) {
    // Pick top-level or primary service/app modules
    const depth = dirPath.split('/').length;
    if (depth <= 3 && count >= 1) {
      let description = 'Application module';
      const lower = dirPath.toLowerCase();

      if (lower.includes('routes') || lower.includes('router') || lower.includes('api')) {
        description = 'HTTP API routing and request handling';
      } else if (lower.includes('services') || lower.includes('service')) {
        description = 'Core business logic and service domain layer';
      } else if (lower.includes('components') || lower.includes('ui')) {
        description = 'User interface components and presentation';
      } else if (lower.includes('middlewares') || lower.includes('middleware')) {
        description = 'Request interceptors, authentication & error handlers';
      } else if (lower.includes('contracts') || lower.includes('dto')) {
        description = 'Shared API schemas, types, and validation models';
      } else if (lower.includes('tests') || lower.includes('test')) {
        description = 'Automated unit and integration test suite';
      } else if (lower.includes('infra') || lower.includes('docker')) {
        description = 'Infrastructure configuration and container definitions';
      }

      keyModules.push({
        name: path.basename(dirPath),
        path: dirPath,
        description,
        fileCount: count,
      });
    }
  }

  // Sort key modules by file count descending, take top 15
  keyModules.sort((a, b) => b.fileCount - a.fileCount);
  const selectedModules = keyModules.slice(0, 15);

  // 3. API Routes Detection
  const apiRoutes: ApiRouteLocation[] = [];
  for (const f of eligibleFiles) {
    const p = f.path.replace(/\\/g, '/');
    const lower = p.toLowerCase();
    if (
      lower.includes('routes/') ||
      lower.includes('router') ||
      lower.includes('controllers/') ||
      lower.includes('endpoints/')
    ) {
      // Inspect static route patterns if file size is reasonable
      let framework = 'Express/FastAPI';
      if (f.extension === '.ts' || f.extension === '.js') framework = 'Express.js';
      if (f.extension === '.py') framework = 'FastAPI';

      apiRoutes.push({
        path: p,
        handlerFile: p,
        framework,
      });
    }
  }

  // 4. Service Locations
  const serviceLocations: string[] = eligibleFiles
    .filter((f) => {
      const p = f.path.replace(/\\/g, '/').toLowerCase();
      return (
        p.includes('/services/') ||
        p.endsWith('service.ts') ||
        p.endsWith('service.js') ||
        p.endsWith('_service.py')
      );
    })
    .map((f) => f.path.replace(/\\/g, '/'));

  // 5. Model Locations
  const modelLocations: string[] = eligibleFiles
    .filter((f) => {
      const p = f.path.replace(/\\/g, '/').toLowerCase();
      return (
        p.includes('schema.prisma') ||
        p.includes('/models/') ||
        p.includes('/entities/') ||
        p.endsWith('schemas.py') ||
        p.endsWith('models.py')
      );
    })
    .map((f) => f.path.replace(/\\/g, '/'));

  // 6. Test Locations & Frameworks
  const testFiles = eligibleFiles.filter((f) => f.category === 'TEST');
  const testLocations = testFiles.map((f) => f.path.replace(/\\/g, '/'));
  const testFrameworksSet = new Set<string>();

  for (const tf of testFiles) {
    if (tf.extension === '.ts' || tf.extension === '.tsx' || tf.extension === '.js') {
      testFrameworksSet.add('Vitest / Jest');
    } else if (tf.extension === '.py') {
      testFrameworksSet.add('pytest');
    } else if (tf.extension === '.go') {
      testFrameworksSet.add('go test');
    }
  }

  // 7. Configuration Locations
  const configurationLocations = eligibleFiles
    .filter((f) => f.category === 'CONFIG' || f.category === 'INFRASTRUCTURE')
    .map((f) => f.path.replace(/\\/g, '/'));

  // 8. Static Relationship Extraction (Sample up to 60 relevant source files)
  const filesToScan = eligibleFiles
    .filter((f) => f.category === 'SOURCE' || f.category === 'TEST')
    .slice(0, 60);

  for (const src of filesToScan) {
    const fullPath = path.join(repositoryRoot, src.path);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const srcDir = path.dirname(src.path).replace(/\\/g, '/');

    // JS/TS imports: from './...' or require('./...')
    const tsImportRegex = /(?:from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
    let match: RegExpExecArray | null;
    while ((match = tsImportRegex.exec(content)) !== null) {
      const importTarget = match[1] || match[2];
      if (importTarget && importTarget.startsWith('.')) {
        // Resolve relative import
        const resolved = path.normalize(path.join(srcDir, importTarget)).replace(/\\/g, '/');
        const stripped = resolved.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, '');
        // Match against pathSet directly or with common extensions
        const possibleTargets = [
          resolved,
          stripped,
          `${stripped}.ts`,
          `${stripped}.tsx`,
          `${stripped}.js`,
          `${stripped}.jsx`,
          `${stripped}/index.ts`,
          `${stripped}/index.js`,
        ];
        for (const target of possibleTargets) {
          if (pathSet.has(target)) {
            relationships.push({
              sourceFile: src.path.replace(/\\/g, '/'),
              targetFile: target,
              relationshipType: src.category === 'TEST' ? 'TESTS' : 'IMPORTS',
              evidence: `Static import: ${match[0]}`,
            });
            break;
          }
        }
      }
    }

    // Python imports: from . import x or from app.y import z
    if (src.extension === '.py') {
      const pyImportRegex = /(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/g;
      let pyMatch: RegExpExecArray | null;
      while ((pyMatch = pyImportRegex.exec(content)) !== null) {
        const mod = pyMatch[1] || pyMatch[2];
        if (mod) {
          const modPath = mod.replace(/\./g, '/') + '.py';
          for (const target of normalizedPaths) {
            if (target.endsWith(modPath)) {
              relationships.push({
                sourceFile: src.path.replace(/\\/g, '/'),
                targetFile: target,
                relationshipType: src.category === 'TEST' ? 'TESTS' : 'IMPORTS',
                evidence: `Python import: ${pyMatch[0]}`,
              });
              break;
            }
          }
        }
      }
    }
  }

  // Deduplicate relationships
  const dedupedRelMap = new Map<string, FileRelationship>();
  for (const rel of relationships) {
    const key = `${rel.sourceFile}->${rel.targetFile}`;
    if (!dedupedRelMap.has(key)) {
      dedupedRelMap.set(key, rel);
    }
  }

  const finalRelationships = Array.from(dedupedRelMap.values()).slice(0, 100);

  // Confidence & Overview
  const repositoryOverview = `Repository contains ${eligibleFiles.length} analyzed files across ${selectedModules.length} primary modules. Discovered ${entryPoints.length} application entry points, ${apiRoutes.length} route definitions, and ${testLocations.length} automated test files.`;

  return {
    repositoryOverview,
    entryPoints,
    keyModules: selectedModules,
    apiRoutes,
    serviceLocations,
    modelLocations,
    testFrameworks: Array.from(testFrameworksSet),
    testLocations,
    configurationLocations,
    relationships: finalRelationships,
    limitations,
    confidence: eligibleFiles.length > 0 ? 0.95 : 0.2,
  };
}
