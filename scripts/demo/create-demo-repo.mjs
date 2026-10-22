#!/usr/bin/env node
// Builds the demo git repository used by the full stack, the e2e suite and
// `npm run demo:seed`: `main` holds the fixture demo_app, and each fixture
// diff (services/agent-service/tests/fixtures/diffs) is one commit on its own
// branch, as listed in cases.json. Author, committer and dates are fixed, so
// the commit SHAs are the same on every machine.
//
// Usage: node scripts/demo/create-demo-repo.mjs <target-dir> [fixtures-dir]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [targetArg, fixturesArg] = process.argv.slice(2);
if (!targetArg) {
  console.error('Usage: node scripts/demo/create-demo-repo.mjs <target-dir> [fixtures-dir]');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(targetArg);
const fixtures = path.resolve(fixturesArg ?? path.join(here, '../../services/agent-service/tests/fixtures'));
const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));

if (fs.existsSync(path.join(target, '.git'))) {
  console.log(`Demo repository already exists at ${target}`);
  process.exit(0);
}

const identity = { name: 'ASEA Demo', email: 'demo@asea.invalid', date: '2026-10-01T09:00:00Z' };
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: identity.name,
  GIT_AUTHOR_EMAIL: identity.email,
  GIT_AUTHOR_DATE: identity.date,
  GIT_COMMITTER_NAME: identity.name,
  GIT_COMMITTER_EMAIL: identity.email,
  GIT_COMMITTER_DATE: identity.date,
};
const git = (...args) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-C', target, ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();

fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(fixtures, 'demo_app'), target, {
  recursive: true,
  filter: (src) => !src.split(path.sep).includes('__pycache__'),
});
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'Demo app: projects API with login, payload validation and tests');

for (const demo of cases) {
  git('checkout', '-q', '-b', demo.branch, 'main');
  git('apply', path.join(fixtures, 'diffs', `${demo.case}.diff`));
  git('add', '-A');
  git('commit', '-q', '-m', demo.commitMessage);
}
git('checkout', '-q', 'main');

console.log(`Demo repository created at ${target}`);
console.log(git('for-each-ref', '--format=  %(objectname:short) %(refname:short)', 'refs/heads'));
