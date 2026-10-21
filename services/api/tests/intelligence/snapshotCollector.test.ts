import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  collectRepositorySnapshot,
  validateAndCanonicalizePath,
  classifyFile,
  isSecretFile,
  isBinaryBuffer,
} from '../../src/services/intelligence/snapshotCollector.js';

describe('Repository Intelligence: Snapshot Collector & Security Controls', () => {
  let tempRoot: string;
  let repoDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-repo-intel-test-'));
    repoDir = path.join(tempRoot, 'safe-repo');
    outsideDir = path.join(tempRoot, 'outside-secret-area');

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Seed outside sensitive file
    fs.writeFileSync(path.join(outsideDir, 'super_secret.txt'), 'TOP_SECRET_CONTENT');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('validates and accepts canonical path inside allowed root', () => {
    const canonical = validateAndCanonicalizePath(repoDir, [tempRoot]);
    expect(canonical).toBe(fs.realpathSync(repoDir));
  });

  it('rejects path traversal attempting to escape allowed roots', () => {
    const maliciousTraversal = path.join(repoDir, '..', 'outside-secret-area');
    expect(() => validateAndCanonicalizePath(maliciousTraversal, [repoDir])).toThrow(
      /Access denied/i
    );
  });

  it('rejects non-existent repository paths', () => {
    const nonExistent = path.join(repoDir, 'does-not-exist');
    expect(() => validateAndCanonicalizePath(nonExistent, [tempRoot])).toThrow(/does not exist/i);
  });

  it('rejects paths pointing to files instead of directories', () => {
    const filePath = path.join(repoDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello');
    expect(() => validateAndCanonicalizePath(filePath, [tempRoot])).toThrow(
      /not a directory/i
    );
  });

  it('prevents symlink-based escapes targeting directories outside repository root', async () => {
    const escapedSymlink = path.join(repoDir, 'sneaky_symlink');
    try {
      fs.symlinkSync(outsideDir, escapedSymlink, 'dir');
    } catch {
      // On Windows non-admin symlink might fail; if so, skip symlink creation
      return;
    }

    const result = await collectRepositorySnapshot(repoDir, {
      allowedRoots: [repoDir],
    });

    const hasOutsideFile = result.files.some((f) => f.path.includes('super_secret.txt'));
    expect(hasOutsideFile).toBe(false);
    expect(
      result.limitations.some((l) => l.includes('outside repository boundary'))
    ).toBe(true);
  });

  it('excludes secret files from inventory (.env, *.pem, *.key, credentials.json)', async () => {
    fs.writeFileSync(path.join(repoDir, '.env'), 'DB_PASSWORD=secret');
    fs.writeFileSync(path.join(repoDir, '.env.production'), 'API_KEY=prodsecret');
    fs.writeFileSync(path.join(repoDir, 'server.key'), 'PRIVATE_KEY');
    fs.writeFileSync(path.join(repoDir, 'cert.pem'), 'CERTIFICATE');
    fs.writeFileSync(path.join(repoDir, 'credentials.json'), '{"secret":"value"}');
    fs.writeFileSync(path.join(repoDir, 'main.ts'), 'console.log("hello");');

    const result = await collectRepositorySnapshot(repoDir, {
      allowedRoots: [tempRoot],
    });

    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('main.ts');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('.env.production');
    expect(paths).not.toContain('server.key');
    expect(paths).not.toContain('cert.pem');
    expect(paths).not.toContain('credentials.json');
    expect(result.statistics.secretFilesExcluded).toBeGreaterThanOrEqual(4);
  });

  it('detects and skips binary files using both extension and null-byte content sniffing', async () => {
    fs.writeFileSync(path.join(repoDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const binaryBuffer = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]); // Contains null byte
    fs.writeFileSync(path.join(repoDir, 'compiled.dat'), binaryBuffer);
    fs.writeFileSync(path.join(repoDir, 'script.py'), 'print("valid text file")');

    const result = await collectRepositorySnapshot(repoDir, {
      allowedRoots: [tempRoot],
    });

    const scriptFile = result.files.find((f) => f.path === 'script.py');
    const imageFile = result.files.find((f) => f.path === 'image.png');
    const binaryFile = result.files.find((f) => f.path === 'compiled.dat');

    expect(scriptFile?.skippedReason).toBeUndefined();
    expect(imageFile?.skippedReason).toBe('Binary file extension');
    expect(binaryFile?.skippedReason).toBe('Binary content detected');
    expect(result.statistics.binaryFilesSkipped).toBe(2);
  });

  it('enforces maximum file count limit and notes limitation', async () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(repoDir, `file_${i}.ts`), `export const v${i} = ${i};`);
    }

    const result = await collectRepositorySnapshot(repoDir, {
      allowedRoots: [tempRoot],
      maxFiles: 5,
    });

    expect(result.files.length).toBe(5);
    expect(result.limitations.some((l) => l.includes('Maximum file count limit'))).toBe(true);
  });

  it('enforces maximum file size limit on oversized files', async () => {
    fs.writeFileSync(path.join(repoDir, 'small.ts'), 'const a = 1;');
    fs.writeFileSync(path.join(repoDir, 'huge.ts'), 'x'.repeat(5000));

    const result = await collectRepositorySnapshot(repoDir, {
      allowedRoots: [tempRoot],
      maxFileSizeBytes: 1000,
    });

    const small = result.files.find((f) => f.path === 'small.ts');
    const huge = result.files.find((f) => f.path === 'huge.ts');

    expect(small?.skippedReason).toBeUndefined();
    expect(huge?.skippedReason).toContain('exceeds limit');
  });

  it('correctly classifies files into categories', () => {
    expect(classifyFile('src/services/auth.ts')).toBe('SOURCE');
    expect(classifyFile('tests/unit/auth.test.ts')).toBe('TEST');
    expect(classifyFile('package.json')).toBe('CONFIG');
    expect(classifyFile('tsconfig.json')).toBe('CONFIG');
    expect(classifyFile('README.md')).toBe('DOCUMENTATION');
    expect(classifyFile('compose.yaml')).toBe('INFRASTRUCTURE');
    expect(classifyFile('unknown.xyz')).toBe('UNKNOWN');
  });

  it('isSecretFile correctly catches diverse secret filename patterns', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('.env.local')).toBe(true);
    expect(isSecretFile('server.key')).toBe(true);
    expect(isSecretFile('id_rsa')).toBe(true);
    expect(isSecretFile('credentials.json')).toBe(true);
    expect(isSecretFile('service-account-key.json')).toBe(true);
    expect(isSecretFile('database.kdbx')).toBe(true);
    expect(isSecretFile('server.ts')).toBe(false);
    expect(isSecretFile('README.md')).toBe(false);
  });

  it('isBinaryBuffer detects null bytes within sample buffer', () => {
    expect(isBinaryBuffer(Buffer.from('plain text'))).toBe(false);
    expect(isBinaryBuffer(Buffer.from([0x01, 0x02, 0x00, 0x04]))).toBe(true);
  });
});
