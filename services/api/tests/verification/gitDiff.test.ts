import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VerificationRequestSchema } from '@autonomous-engineer/contracts';
import { VerificationInputError, buildVerificationRequest, listBranches, readTreeFiles } from '../../src/services/verification/gitDiff.js';

// A real git repository in a temp dir: base commit, then a head commit that
// modifies, adds, deletes and adds a binary file. Each test spawns many git
// processes, which can take several seconds on a loaded Windows machine.
const GIT_TEST_TIMEOUT_MS = 30000;

describe('buildVerificationRequest (git)', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  let dir: string;
  let base: string;
  let head: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  const build = (overrides: Partial<Parameters<typeof buildVerificationRequest>[0]> = {}) =>
    buildVerificationRequest({
      repositoryId: 'repo-1',
      repoPath: dir,
      baseSha: base,
      headSha: head,
      requirement: 'Add a greeting',
      authorType: 'ai',
      maxRequestBytes: 5 * 1024 * 1024,
      ...overrides,
    });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-git-'));
    git('init', '-q');
    for (const [key, value] of [
      ['core.autocrlf', 'false'],
      ['user.email', 'test@example.invalid'],
      ['user.name', 'test'],
      ['commit.gpgsign', 'false'],
    ]) {
      git('config', key, value);
    }
    write('app/service.py', 'def greet():\n    return "hi"\n');
    write('docs/old.md', '# old\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');

    write('app/service.py', 'def greet(name):\n    return f"hi {name}"\n');
    write('app/new.py', 'VALUE = 1\n');
    write('assets/blob.bin', Buffer.from([0, 1, 2, 0, 255]));
    fs.rmSync(path.join(dir, 'docs/old.md'));
    git('add', '-A');
    git('commit', '-q', '-m', 'head');
    head = git('rev-parse', 'HEAD');
  }, GIT_TEST_TIMEOUT_MS);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the diff and head content of added and modified text files', async () => {
    const request = await build({ baseSha: base.slice(0, 7) });

    expect(VerificationRequestSchema.parse(request)).toEqual(request);
    expect(request.base_sha).toBe(base); // short SHA resolved to the full one
    expect(request.head_sha).toBe(head);
    expect(request.author_type).toBe('ai');
    expect(request.changed_files).toEqual([
      { path: 'app/new.py', head_content: 'VALUE = 1\n' },
      { path: 'app/service.py', head_content: 'def greet(name):\n    return f"hi {name}"\n' },
    ]);
    expect(request.unified_diff).toContain('diff --git a/app/service.py b/app/service.py');
    expect(request.unified_diff).toContain('+    return f"hi {name}"');
    expect(request.unified_diff).toContain('deleted file mode');
  });

  it('rejects SHAs that are not hex commit ids, unknown commits and non-repositories', async () => {
    await expect(build({ headSha: 'HEAD' })).rejects.toThrow(VerificationInputError);
    await expect(build({ headSha: '--output=x' })).rejects.toThrow(/not a 7-40 character hex/);
    await expect(build({ headSha: 'deadbeefdeadbeef' })).rejects.toThrow(/git rev-parse failed/);
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'asea-norepo-'));
    try {
      await expect(build({ repoPath: notRepo })).rejects.toThrow(VerificationInputError);
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('rejects a request over the size limit', async () => {
    await expect(build({ maxRequestBytes: 100 })).rejects.toThrow(/over the 100-byte limit/);
  });

  it('does not run external diff or textconv commands configured by the repository', async () => {
    const marker = path.join(dir, '..', `${path.basename(dir)}-pwned`).replace(/\\/g, '/');
    git('config', 'diff.external', `touch "${marker}-external" #`);
    git('config', 'diff.evil.textconv', `touch "${marker}-textconv" #`);
    write('.git/info/attributes', '*.py diff=evil\n');
    try {
      // The repository config really does run commands under a plain `git diff`
      git('diff', base, head);
      expect(fs.existsSync(`${marker}-external`)).toBe(true);
      fs.rmSync(`${marker}-external`);

      const request = await build();

      expect(fs.existsSync(`${marker}-external`)).toBe(false);
      expect(fs.existsSync(`${marker}-textconv`)).toBe(false);
      expect(request.unified_diff).toContain('diff --git a/app/service.py b/app/service.py');
    } finally {
      git('config', '--unset', 'diff.external');
      git('config', '--unset', 'diff.evil.textconv');
      fs.rmSync(path.join(dir, '.git/info/attributes'), { force: true });
      fs.rmSync(`${marker}-external`, { force: true });
      fs.rmSync(`${marker}-textconv`, { force: true });
    }
  });

  // Both commits may share a timestamp here, so only membership is checked, not the order
  it('lists local branches with their commit and subject', async () => {
    const current = git('rev-parse', '--abbrev-ref', 'HEAD');
    git('branch', 'feature/older', base);
    try {
      const branches = await listBranches(dir);
      expect(branches.map((b) => [b.name, b.sha, b.subject]).sort()).toEqual(
        [
          [current, head, 'head'],
          ['feature/older', base, 'base'],
        ].sort()
      );
      expect(new Date(branches[0]!.committedAt).toISOString()).toBe(branches[0]!.committedAt);
    } finally {
      git('branch', '-D', 'feature/older');
    }
  });

  it('reads the files of a commit with one cat-file process, filtered and limited', async () => {
    // head has app/new.py and app/service.py (and a binary and a markdown file that are skipped)
    const all = await readTreeFiles(dir, head.slice(0, 10), { extensions: ['.py'], maxFiles: 100, maxBytes: 1_000_000 });
    expect(all.commitSha).toBe(head);
    expect(all.truncated).toBe(false);
    expect(all.files).toEqual([
      { path: 'app/new.py', content: 'VALUE = 1\n' },
      { path: 'app/service.py', content: 'def greet(name):\n    return f"hi {name}"\n' },
    ]);

    const atBase = await readTreeFiles(dir, base, { extensions: ['.py', '.md'], maxFiles: 100, maxBytes: 1_000_000 });
    expect(atBase.files.map((f) => f.path)).toEqual(['app/service.py', 'docs/old.md']);

    const limited = await readTreeFiles(dir, head, { extensions: ['.py'], maxFiles: 1, maxBytes: 1_000_000 });
    expect(limited).toMatchObject({ truncated: true, files: [{ path: 'app/new.py' }] });
    expect((await readTreeFiles(dir, head, { extensions: ['.py'], maxFiles: 100, maxBytes: 12 })).files.map((f) => f.path)).toEqual(['app/new.py']);
    expect((await readTreeFiles(dir, head, { extensions: ['.bin'], maxFiles: 100, maxBytes: 1_000_000 })).files).toEqual([]);
    await expect(readTreeFiles(dir, 'HEAD', { extensions: ['.py'], maxFiles: 1, maxBytes: 1 })).rejects.toThrow(VerificationInputError);
  });
});
