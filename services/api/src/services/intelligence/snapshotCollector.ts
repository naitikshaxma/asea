import fs from 'node:fs';
import path from 'node:path';
import type { FileCategory, FileInventoryItem } from '@autonomous-engineer/contracts';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

export interface SnapshotCollectionOptions {
  allowedRoots?: string[];
  maxFiles?: number;
  maxFileSizeBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
}

export interface SnapshotCollectionResult {
  repositoryRoot: string;
  files: FileInventoryItem[];
  statistics: {
    totalFiles: number;
    eligibleFiles: number;
    skippedFiles: number;
    totalBytes: number;
    durationMs: number;
    binaryFilesSkipped: number;
    secretFilesExcluded: number;
  };
  limitations: string[];
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.venv',
  'venv',
  'env',
  '.env',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.cargo',
]);

const SECRET_FILE_PATTERNS = [
  /^\.env($|\..+)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pkcs12$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /id_rsa/i,
  /id_dsa/i,
  /id_ecdsa/i,
  /id_ed25519/i,
  /credentials\.json$/i,
  /service-account.*\.json$/i,
  /secret/i,
  /token/i,
  /\.kdbx$/i,
];

const KNOWN_BINARY_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.iso',
  '.tar',
  '.gz',
  '.zip',
  '.7z',
  '.rar',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.pdf',
  '.wasm',
  '.pyc',
  '.class',
  '.jar',
  '.war',
  '.o',
  '.a',
  '.obj',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

const LANGUAGE_EXTENSION_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.c': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.h': 'C/C++ Header',
  '.hpp': 'C++ Header',
  '.cs': 'C#',
  '.php': 'PHP',
  '.rb': 'Ruby',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.ps1': 'PowerShell',
  '.sql': 'SQL',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'Sass',
  '.less': 'Less',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.xml': 'XML',
  '.toml': 'TOML',
  '.md': 'Markdown',
  '.mdx': 'Markdown',
  '.dockerfile': 'Dockerfile',
  '.prisma': 'Prisma',
};

export function isBinaryBuffer(buffer: Buffer): boolean {
  const bytesToCheck = Math.min(buffer.length, 512);
  for (let i = 0; i < bytesToCheck; i++) {
    const byte = buffer[i];
    if (byte === 0) {
      return true; // Null byte indicates binary content
    }
  }
  return false;
}

export function isSecretFile(filename: string): boolean {
  const base = path.basename(filename);
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

export function classifyFile(relativePath: string): FileCategory {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);
  const ext = path.extname(normalized);

  // Tests
  if (
    normalized.includes('/tests/') ||
    normalized.includes('/test/') ||
    normalized.includes('/__tests__/') ||
    base.includes('.test.') ||
    base.includes('.spec.') ||
    base.startsWith('test_')
  ) {
    return 'TEST';
  }

  // Documentation
  if (
    normalized.startsWith('docs/') ||
    normalized.includes('/docs/') ||
    base.startsWith('readme') ||
    base.startsWith('contributing') ||
    base.startsWith('license') ||
    base.startsWith('changelog') ||
    ext === '.md' ||
    ext === '.mdx'
  ) {
    return 'DOCUMENTATION';
  }

  // Infrastructure & Containers
  if (
    base === 'dockerfile' ||
    base.startsWith('dockerfile.') ||
    base === 'docker-compose.yml' ||
    base === 'docker-compose.yaml' ||
    base === 'compose.yaml' ||
    base === 'compose.yml' ||
    normalized.startsWith('.github/') ||
    normalized.startsWith('infra/') ||
    normalized.includes('/docker/')
  ) {
    return 'INFRASTRUCTURE';
  }

  // Configuration
  if (
    base.endsWith('rc') ||
    base.includes('config') ||
    base === 'package.json' ||
    base === 'tsconfig.json' ||
    base === 'pyproject.toml' ||
    base === 'requirements.txt' ||
    base === 'go.mod' ||
    base === 'cargo.toml' ||
    ext === '.toml' ||
    (ext === '.json' && !normalized.includes('/src/')) ||
    (ext === '.yaml' && !normalized.includes('/src/')) ||
    (ext === '.yml' && !normalized.includes('/src/'))
  ) {
    return 'CONFIG';
  }

  // Source files
  if (
    [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.py',
      '.go',
      '.rs',
      '.java',
      '.c',
      '.cpp',
      '.h',
      '.hpp',
      '.cs',
      '.php',
      '.rb',
      '.sql',
      '.prisma',
    ].includes(ext)
  ) {
    return 'SOURCE';
  }

  return 'UNKNOWN';
}

/**
 * Parses a comma-separated ALLOWED_REPO_ROOTS value. Empty entries are dropped:
 * path.resolve('') would silently resolve to the process cwd.
 */
export function parseAllowedRoots(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * Validates that candidatePath is canonically located inside at least one approved root.
 * Protects against directory traversal, relative navigation, and symlink-based escapes.
 */
export function validateAndCanonicalizePath(
  candidatePath: string,
  allowedRootsConfig?: string[]
): string {
  if (!candidatePath || typeof candidatePath !== 'string') {
    throw new Error('Repository path must be a non-empty string');
  }

  // Resolve raw path
  const absoluteCandidate = path.resolve(candidatePath);

  // Check existence
  if (!fs.existsSync(absoluteCandidate)) {
    throw new Error(`Repository path does not exist: ${candidatePath}`);
  }

  // Resolve real canonical path (evaluates symlinks)
  const canonicalPath = fs.realpathSync(absoluteCandidate);

  // Resolve allowed roots
  const configuredRoots = allowedRootsConfig || parseAllowedRoots(config.ALLOWED_REPO_ROOTS);
  if (configuredRoots.length === 0) {
    throw new Error('No allowed repository roots are configured (ALLOWED_REPO_ROOTS).');
  }
  const allowedRoots = configuredRoots.map((r) => {
    try {
      return fs.existsSync(r) ? fs.realpathSync(path.resolve(r)) : path.resolve(r);
    } catch {
      return path.resolve(r);
    }
  });

  // Check if canonicalPath starts with any allowed root
  const isAllowed = allowedRoots.some((allowed) => {
    const rel = path.relative(allowed, canonicalPath);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });

  if (!isAllowed) {
    throw new Error(
      `Access denied: Repository path '${candidatePath}' is outside the configured allowed roots.`
    );
  }

  const stat = fs.statSync(canonicalPath);
  if (!stat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${candidatePath}`);
  }

  return canonicalPath;
}

/**
 * Collects a safe snapshot inventory of files from the repository root.
 */
export async function collectRepositorySnapshot(
  repositoryPath: string,
  options: SnapshotCollectionOptions = {}
): Promise<SnapshotCollectionResult> {
  const startTime = Date.now();
  const canonicalRoot = validateAndCanonicalizePath(repositoryPath, options.allowedRoots);

  const maxFiles = options.maxFiles ?? config.ANALYSIS_MAX_FILES;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? config.ANALYSIS_MAX_FILE_SIZE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? config.ANALYSIS_MAX_TOTAL_BYTES;
  const timeoutMs = options.timeoutMs ?? config.ANALYSIS_TIMEOUT_MS;

  const files: FileInventoryItem[] = [];
  const limitations: string[] = [];
  let totalFiles = 0;
  let skippedFiles = 0;
  let totalBytes = 0;
  let binaryFilesSkipped = 0;
  let secretFilesExcluded = 0;

  function walk(currentDir: string): void {
    if (Date.now() - startTime > timeoutMs) {
      limitations.push(`Analysis timeout of ${timeoutMs}ms exceeded; scan truncated.`);
      return;
    }

    if (files.length >= maxFiles) {
      limitations.push(`Maximum file count limit (${maxFiles}) reached; scan truncated.`);
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err: unknown) {
      logger.warn(`Failed to read directory during snapshot: ${currentDir}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        limitations.push(`Maximum file count limit (${maxFiles}) reached; scan truncated.`);
        break;
      }

      const fullPath = path.join(currentDir, entry.name);

      // Verify symlinks don't escape repository boundary
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const rel = path.relative(canonicalRoot, realTarget);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            // Symlink escapes root boundary - reject/skip
            skippedFiles++;
            limitations.push(`Symlink ${entry.name} points outside repository boundary; skipped.`);
            continue;
          }
          const targetStat = fs.statSync(realTarget);
          isDir = targetStat.isDirectory();
          isFile = targetStat.isFile();
        } catch {
          skippedFiles++;
          continue;
        }
      }

      if (isDir) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (isFile) {
        totalFiles++;
        const relativePath = path.relative(canonicalRoot, fullPath).replace(/\\/g, '/');

        // Check secret file pattern
        if (isSecretFile(entry.name)) {
          secretFilesExcluded++;
          skippedFiles++;
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();

        // Check binary extension
        if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
          binaryFilesSkipped++;
          skippedFiles++;
          files.push({
            path: relativePath,
            extension: ext,
            language: undefined,
            sizeBytes: 0,
            category: 'UNKNOWN',
            skippedReason: 'Binary file extension',
          });
          continue;
        }

        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          skippedFiles++;
          continue;
        }

        // Check file size limits
        if (stat.size > maxFileSizeBytes) {
          skippedFiles++;
          files.push({
            path: relativePath,
            extension: ext,
            language: LANGUAGE_EXTENSION_MAP[ext],
            sizeBytes: stat.size,
            category: classifyFile(relativePath),
            skippedReason: `File size (${stat.size}B) exceeds limit (${maxFileSizeBytes}B)`,
          });
          continue;
        }

        if (totalBytes + stat.size > maxTotalBytes) {
          limitations.push(`Maximum total byte limit (${maxTotalBytes}B) reached; scan bounded.`);
          break;
        }

        // Quick binary content sniffing
        let isBinary = false;
        try {
          const fd = fs.openSync(fullPath, 'r');
          const sample = Buffer.alloc(512);
          const bytesRead = fs.readSync(fd, sample, 0, 512, 0);
          fs.closeSync(fd);
          if (bytesRead > 0 && isBinaryBuffer(sample.subarray(0, bytesRead))) {
            isBinary = true;
          }
        } catch {
          isBinary = false;
        }

        if (isBinary) {
          binaryFilesSkipped++;
          skippedFiles++;
          files.push({
            path: relativePath,
            extension: ext,
            language: undefined,
            sizeBytes: stat.size,
            category: 'UNKNOWN',
            skippedReason: 'Binary content detected',
          });
          continue;
        }

        totalBytes += stat.size;
        files.push({
          path: relativePath,
          extension: ext,
          language: LANGUAGE_EXTENSION_MAP[ext],
          sizeBytes: stat.size,
          category: classifyFile(relativePath),
        });
      }
    }
  }

  walk(canonicalRoot);

  const durationMs = Date.now() - startTime;
  const eligibleFiles = files.filter((f) => !f.skippedReason).length;

  return {
    repositoryRoot: canonicalRoot,
    files,
    statistics: {
      totalFiles,
      eligibleFiles,
      skippedFiles,
      totalBytes,
      durationMs,
      binaryFilesSkipped,
      secretFilesExcluded,
    },
    limitations,
  };
}
