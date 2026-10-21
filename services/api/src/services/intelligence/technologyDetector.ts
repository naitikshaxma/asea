import fs from 'node:fs';
import path from 'node:path';
import type { TechnologyFinding } from '@autonomous-engineer/contracts';
import type { FileInventoryItem } from '@autonomous-engineer/contracts';

export function detectTechnologies(
  repositoryRoot: string,
  inventory: FileInventoryItem[]
): TechnologyFinding[] {
  const findings: TechnologyFinding[] = [];
  const filesByPath = new Set(inventory.map((f) => f.path.replace(/\\/g, '/')));

  function readFileSafe(relPath: string): string | null {
    try {
      const full = path.join(repositoryRoot, relPath);
      if (fs.existsSync(full)) {
        return fs.readFileSync(full, 'utf-8');
      }
    } catch {
      // Ignore read errors
    }
    return null;
  }

  // 1. Node.js / TypeScript / JavaScript
  const packageJsonFiles = inventory.filter(
    (f) => path.basename(f.path) === 'package.json' && !f.skippedReason
  );

  for (const pkgFile of packageJsonFiles) {
    const content = readFileSafe(pkgFile.path);
    if (!content) continue;

    try {
      const parsed = JSON.parse(content);
      const allDeps = {
        ...(parsed.dependencies || {}),
        ...(parsed.devDependencies || {}),
        ...(parsed.peerDependencies || {}),
      };

      findings.push({
        name: 'Node.js',
        category: 'LANGUAGE',
        confidence: 1.0,
        evidenceFiles: [pkgFile.path],
        rationale: `Detected Node.js ecosystem manifest at ${pkgFile.path}`,
        version: parsed.engines?.node,
      });

      if (allDeps['typescript'] || filesByPath.has('tsconfig.json')) {
        findings.push({
          name: 'TypeScript',
          category: 'LANGUAGE',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path, ...(filesByPath.has('tsconfig.json') ? ['tsconfig.json'] : [])],
          rationale: `TypeScript dependency and configuration detected`,
          version: allDeps['typescript'],
        });
      }

      // Frameworks
      if (allDeps['express']) {
        findings.push({
          name: 'Express.js',
          category: 'FRAMEWORK',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path],
          rationale: `Express web framework defined in dependencies (${allDeps['express']})`,
          version: allDeps['express'],
        });
      }

      if (allDeps['react']) {
        findings.push({
          name: 'React',
          category: 'FRAMEWORK',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path],
          rationale: `React UI library defined in dependencies (${allDeps['react']})`,
          version: allDeps['react'],
        });
      }

      if (allDeps['next']) {
        findings.push({
          name: 'Next.js',
          category: 'FRAMEWORK',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path],
          rationale: `Next.js application framework defined in dependencies`,
          version: allDeps['next'],
        });
      }

      if (allDeps['vite']) {
        findings.push({
          name: 'Vite',
          category: 'BUILD_TOOL',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path],
          rationale: `Vite build tool and bundler defined in dependencies`,
          version: allDeps['vite'],
        });
      }

      if (allDeps['vitest']) {
        findings.push({
          name: 'Vitest',
          category: 'TEST_RUNNER',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path],
          rationale: `Vitest test framework defined in dependencies`,
          version: allDeps['vitest'],
        });
      } else if (allDeps['jest']) {
        findings.push({
          name: 'Jest',
          category: 'TEST_RUNNER',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path],
          rationale: `Jest test runner defined in dependencies`,
          version: allDeps['jest'],
        });
      }

      // Databases / ORMs / Queues
      if (allDeps['@prisma/client'] || allDeps['prisma']) {
        findings.push({
          name: 'Prisma ORM',
          category: 'DATABASE',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path],
          rationale: `Prisma ORM defined in dependencies`,
          version: allDeps['@prisma/client'] || allDeps['prisma'],
        });
      }

      if (allDeps['bullmq']) {
        findings.push({
          name: 'BullMQ',
          category: 'BUILD_TOOL',
          confidence: 1.0,
          evidenceFiles: [pkgFile.path],
          rationale: `BullMQ message queue defined in dependencies`,
          version: allDeps['bullmq'],
        });
      }

      if (allDeps['pg'] || allDeps['postgres']) {
        findings.push({
          name: 'PostgreSQL Driver',
          category: 'DATABASE',
          confidence: 0.95,
          evidenceFiles: [pkgFile.path],
          rationale: `PostgreSQL client driver defined in dependencies`,
        });
      }

      if (allDeps['ioredis'] || allDeps['redis']) {
        findings.push({
          name: 'Redis Driver',
          category: 'DATABASE',
          confidence: 0.95,
          evidenceFiles: [pkgFile.path],
          rationale: `Redis client library defined in dependencies`,
        });
      }
    } catch {
      // Malformed package.json
    }
  }

  // 2. Python Ecosystem
  const pyproject = inventory.find((f) => path.basename(f.path) === 'pyproject.toml');
  const requirements = inventory.find((f) => path.basename(f.path) === 'requirements.txt');
  const pythonFiles = inventory.filter((f) => f.extension === '.py' && !f.skippedReason);

  if (pyproject || requirements || pythonFiles.length > 0) {
    const evidence = [
      ...(pyproject ? [pyproject.path] : []),
      ...(requirements ? [requirements.path] : []),
    ];

    findings.push({
      name: 'Python',
      category: 'LANGUAGE',
      confidence: 1.0,
      evidenceFiles: evidence.length > 0 ? evidence : [pythonFiles[0]?.path || 'source.py'],
      rationale: `Python source files and manifests discovered (${pythonFiles.length} .py files)`,
    });

    const pyContents = [
      pyproject ? readFileSafe(pyproject.path) : '',
      requirements ? readFileSafe(requirements.path) : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (pyContents.includes('fastapi')) {
      findings.push({
        name: 'FastAPI',
        category: 'FRAMEWORK',
        confidence: 1.0,
        evidenceFiles: evidence,
        rationale: `FastAPI framework declared in Python dependencies`,
      });
    }

    if (pyContents.includes('pydantic')) {
      findings.push({
        name: 'Pydantic',
        category: 'FRAMEWORK',
        confidence: 1.0,
        evidenceFiles: evidence,
        rationale: `Pydantic data validation declared in Python dependencies`,
      });
    }

    if (pyContents.includes('pytest')) {
      findings.push({
        name: 'pytest',
        category: 'TEST_RUNNER',
        confidence: 1.0,
        evidenceFiles: evidence,
        rationale: `pytest testing framework declared in Python dependencies`,
      });
    }

    if (pyContents.includes('django')) {
      findings.push({
        name: 'Django',
        category: 'FRAMEWORK',
        confidence: 1.0,
        evidenceFiles: evidence,
        rationale: `Django web framework declared in Python dependencies`,
      });
    }

    if (pyContents.includes('flask')) {
      findings.push({
        name: 'Flask',
        category: 'FRAMEWORK',
        confidence: 1.0,
        evidenceFiles: evidence,
        rationale: `Flask framework declared in Python dependencies`,
      });
    }
  }

  // 3. Go Ecosystem
  const goMod = inventory.find((f) => path.basename(f.path) === 'go.mod');
  if (goMod) {
    const content = readFileSafe(goMod.path) || '';
    const goVersionMatch = content.match(/^go\s+([0-9.]+)/m);
    findings.push({
      name: 'Go',
      category: 'LANGUAGE',
      confidence: 1.0,
      evidenceFiles: [goMod.path],
      rationale: `Go module file detected at ${goMod.path}`,
      version: goVersionMatch?.[1],
    });
  }

  // 4. Rust Ecosystem
  const cargoToml = inventory.find((f) => path.basename(f.path) === 'Cargo.toml');
  if (cargoToml) {
    findings.push({
      name: 'Rust',
      category: 'LANGUAGE',
      confidence: 1.0,
      evidenceFiles: [cargoToml.path],
      rationale: `Cargo.toml manifest detected at ${cargoToml.path}`,
    });
  }

  // 5. Containers & Docker
  const dockerfiles = inventory.filter((f) => {
    const base = path.basename(f.path).toLowerCase();
    return base === 'dockerfile' || base.startsWith('dockerfile.');
  });
  const composeFiles = inventory.filter((f) => {
    const base = path.basename(f.path).toLowerCase();
    return (
      base === 'docker-compose.yml' ||
      base === 'docker-compose.yaml' ||
      base === 'compose.yaml' ||
      base === 'compose.yml'
    );
  });

  if (dockerfiles.length > 0 || composeFiles.length > 0) {
    const evidence = [
      ...dockerfiles.map((d) => d.path),
      ...composeFiles.map((c) => c.path),
    ];
    findings.push({
      name: 'Docker',
      category: 'CONTAINER',
      confidence: 1.0,
      evidenceFiles: evidence,
      rationale: `Container definitions detected (${dockerfiles.length} Dockerfiles, ${composeFiles.length} Compose files)`,
    });
  }

  // 6. Prisma ORM / Schemas
  const prismaSchemas = inventory.filter((f) => f.extension === '.prisma');
  if (prismaSchemas.length > 0 && !findings.some((f) => f.name === 'Prisma ORM')) {
    findings.push({
      name: 'Prisma ORM',
      category: 'DATABASE',
      confidence: 1.0,
      evidenceFiles: prismaSchemas.map((p) => p.path),
      rationale: `Prisma schema definitions located at ${prismaSchemas[0]?.path}`,
    });
  }

  // Deduplicate findings by name
  const dedupedMap = new Map<string, TechnologyFinding>();
  for (const finding of findings) {
    if (!dedupedMap.has(finding.name)) {
      dedupedMap.set(finding.name, finding);
    } else {
      const existing = dedupedMap.get(finding.name)!;
      existing.evidenceFiles = Array.from(
        new Set([...existing.evidenceFiles, ...finding.evidenceFiles])
      );
    }
  }

  return Array.from(dedupedMap.values());
}
