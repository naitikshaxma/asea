import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const MAX_CHANGED_FILES = 50;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const SECRET_NAME = /(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|\.pkcs12$|id_rsa|id_ed25519|credentials\.json$|service-account.*\.json$|secret|token|\.kdbx$)/i;
const DENIED_SEGMENTS = new Set(['.git', '.svn', '.hg', 'node_modules', '.env', 'venv', '.venv']);

interface PatchFile {
  path: string;
  added: boolean;
  hunks: string[][];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizePatchPath(raw: string): string {
  if (raw.startsWith('"') || raw.includes('\\')) throw new Error('Quoted and backslash patch paths are unsupported');
  if (raw === '/dev/null') return raw;
  const value = raw.replace(/^[ab]\//, '');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error('Absolute patch paths are not allowed');
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || DENIED_SEGMENTS.has(segment))) {
    throw new Error('Patch path contains an unsafe path segment');
  }
  if (segments.some((segment) => SECRET_NAME.test(segment))) throw new Error('Patch may not modify credential or secret files');
  return value;
}

function parseHeaderPath(line: string, marker: '--- ' | '+++ '): string {
  if (!line.startsWith(marker)) throw new Error('Malformed unified diff file header');
  const value = line.slice(marker.length).split('\t', 1)[0]!.trim();
  return normalizePatchPath(value);
}

function splitSource(source: string): { lines: string[]; eol: string; finalNewline: boolean } {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = source.endsWith('\n');
  if (source.length === 0) return { lines: [], eol, finalNewline: false };
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function parseFiles(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: PatchFile[] = [];
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && (lines[index] === '' || lines[index]!.startsWith('diff --git ') || lines[index]!.startsWith('index '))) index++;
    if (index >= lines.length) break;
    if (lines[index]!.startsWith('GIT binary patch') || lines[index]!.startsWith('Binary files ')) {
      throw new Error('Binary patches are unsupported');
    }
    if (lines[index]!.startsWith('old mode ') || lines[index]!.startsWith('new mode ') || lines[index]!.startsWith('rename ') || lines[index]!.startsWith('copy ')) {
      throw new Error('Mode changes, renames, and copies are unsupported');
    }

    const oldPath = parseHeaderPath(lines[index++]!, '--- ');
    if (index >= lines.length) throw new Error('Unified diff is missing its new file header');
    const newPath = parseHeaderPath(lines[index++]!, '+++ ');
    if (oldPath === '/dev/null' && newPath === '/dev/null') throw new Error('Patch has no target path');
    if (newPath === '/dev/null') throw new Error('File deletion patches are unsupported');
    if (oldPath !== '/dev/null' && oldPath !== newPath) throw new Error('File renames are unsupported');

    const hunks: string[][] = [];
    while (index < lines.length && !lines[index]!.startsWith('--- ') && !lines[index]!.startsWith('diff --git ')) {
      const line = lines[index]!;
      if (line === '' && index === lines.length - 1) { index++; break; }
      if (!line.startsWith('@@ ')) {
        if (line.startsWith('old mode ') || line.startsWith('new mode ') || line.startsWith('rename ') || line.startsWith('copy ') || line.startsWith('GIT binary patch')) {
          throw new Error('Patch contains an unsupported file operation');
        }
        if (line.startsWith('index ')) { index++; continue; }
        throw new Error('Malformed unified diff hunk');
      }
      const hunk: string[] = [line];
      index++;
      while (index < lines.length && !lines[index]!.startsWith('@@ ') && !lines[index]!.startsWith('--- ') && !lines[index]!.startsWith('diff --git ')) {
        if (lines[index] === '' && index === lines.length - 1) { index++; break; }
        hunk.push(lines[index++]!);
      }
      hunks.push(hunk);
    }
    if (!hunks.length) throw new Error('Patch file has no hunks');
    files.push({ path: newPath, added: oldPath === '/dev/null', hunks });
  }

  if (!files.length) throw new Error('Patch contains no file changes');
  if (files.length > MAX_CHANGED_FILES) throw new Error(`Patch exceeds the ${MAX_CHANGED_FILES}-file limit`);
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`Patch changes ${file.path} more than once`);
    seen.add(file.path);
  }
  return files;
}

function applyFile(source: string, file: PatchFile): string {
  const split = splitSource(source);
  const sourceLines = split.lines;
  const output: string[] = [];
  let cursor = 0;
  let finalNewline = file.added ? true : split.finalNewline;

  for (const hunk of file.hunks) {
    const header = hunk.shift();
    const match = header?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
    if (!match) throw new Error(`Malformed hunk header for ${file.path}`);
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newCount = Number(match[4] ?? 1);
    const hunkStart = oldCount === 0 ? oldStart : oldStart - 1;
    if (hunkStart < cursor || hunkStart > sourceLines.length) throw new Error(`Hunk position is invalid for ${file.path}`);
    output.push(...sourceLines.slice(cursor, hunkStart));
    cursor = hunkStart;
    let oldSeen = 0;
    let newSeen = 0;
    let lastOperation = '';

    for (let i = 0; i < hunk.length; i++) {
      const line = hunk[i]!;
      if (line === '\\ No newline at end of file') {
        if (lastOperation === '+' || lastOperation === ' ') finalNewline = false;
        continue;
      }
      const operation = line[0];
      const content = line.slice(1);
      if (operation === ' ' || operation === '-') {
        if (sourceLines[cursor] !== content) throw new Error(`Patch context does not match ${file.path}`);
        cursor++;
        oldSeen++;
      }
      if (operation === ' ' || operation === '+') {
        output.push(content);
        newSeen++;
      } else if (operation !== '-') {
        throw new Error(`Malformed patch line for ${file.path}`);
      }
      lastOperation = operation ?? '';
    }
    if (oldSeen !== oldCount || newSeen !== newCount) throw new Error(`Hunk line counts do not match for ${file.path}`);
  }
  output.push(...sourceLines.slice(cursor));
  const result = output.join(split.eol) + (finalNewline ? split.eol : '');
  if (Buffer.byteLength(result, 'utf8') > MAX_OUTPUT_BYTES) throw new Error(`Patched file exceeds the output limit: ${file.path}`);
  return result;
}

function assertSafeTarget(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split('/'));
  if (!isWithin(root, target) || target === root) throw new Error('Patch target escapes the task workspace');
  let current = root;
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Patch target traverses a symbolic link');
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Patch may not replace a symbolic link');
  return target;
}

/** Applies only bounded text additions/modifications inside an isolated task directory. */
export function applyUnifiedPatch(
  workspaceRootInput: string,
  taskWorkspaceInput: string,
  unifiedDiff: string
): { patchHash: string; changedFiles: string[]; baseFiles: Array<{ path: string; sha256: string | null }> } {
  if (Buffer.byteLength(unifiedDiff, 'utf8') > MAX_PATCH_BYTES) throw new Error('Patch exceeds the 5 MiB limit');
  if (unifiedDiff.includes('\0')) throw new Error('Patch contains binary data');
  const workspaceRoot = fs.realpathSync(workspaceRootInput);
  const requestedWorkspace = path.resolve(taskWorkspaceInput);
  if (!isWithin(workspaceRoot, requestedWorkspace) || requestedWorkspace === workspaceRoot || path.relative(workspaceRoot, path.dirname(requestedWorkspace)) !== '') {
    throw new Error('Patch workspace must be inside the configured task workspace root');
  }
  if (fs.lstatSync(requestedWorkspace).isSymbolicLink()) throw new Error('Patch workspace may not be a symbolic link');
  const root = fs.realpathSync(requestedWorkspace);
  if (!isWithin(workspaceRoot, root)) throw new Error('Patch workspace resolves outside the configured task workspace root');
  if (!fs.statSync(root).isDirectory()) throw new Error('Task workspace must be a directory');
  const parsed = parseFiles(unifiedDiff);
  const writes = parsed.map((file) => {
    const target = assertSafeTarget(root, file.path);
    const exists = fs.existsSync(target);
    if (file.added && exists) throw new Error(`Patch addition already exists: ${file.path}`);
    if (!file.added && !exists) throw new Error(`Patch target does not exist: ${file.path}`);
    const original = exists ? fs.readFileSync(target, 'utf8') : '';
    if (original.includes('\0')) throw new Error(`Patch target is not a text file: ${file.path}`);
    return { file, target, exists, original, result: applyFile(original, file) };
  });

  const prior = writes.map(({ target, exists, original }) => ({ target, exists, original }));
  const temporaryPaths: string[] = [];
  try {
    for (const item of writes) {
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      const temporary = path.join(path.dirname(item.target), `.asea-patch-${createHash('sha256').update(item.target).digest('hex').slice(0, 12)}.tmp`);
      temporaryPaths.push(temporary);
      fs.writeFileSync(temporary, item.result, { flag: 'w', mode: 0o600 });
      fs.renameSync(temporary, item.target);
    }
  } catch (error) {
    for (const temporary of temporaryPaths) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
    for (const item of prior.reverse()) {
      try {
        if (item.exists) fs.writeFileSync(item.target, item.original, { mode: 0o600 });
        else if (fs.existsSync(item.target)) fs.unlinkSync(item.target);
      } catch { /* Keep the original apply error; this workspace is disposable. */ }
    }
    throw error;
  }

  return {
    patchHash: createHash('sha256').update(unifiedDiff).digest('hex'),
    changedFiles: writes.map(({ file }) => file.path),
    // Keep only hashes, never original file contents. These let publication
    // confirm that the GitHub base still matches the content that was patched.
    baseFiles: writes.map(({ file, exists, original }) => ({
      path: file.path,
      sha256: exists ? createHash('sha256').update(original, 'utf8').digest('hex') : null,
    })),
  };
}
