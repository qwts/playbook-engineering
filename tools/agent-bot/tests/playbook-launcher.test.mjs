import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  approvedEntrypoint, configPaths, discoverCheckouts, inspectCheckout,
  selectCheckout, validateSelection,
} from '../playbook-launcher.mjs';

const roots = [];
const launcher = fileURLToPath(new URL('../playbook-launcher.mjs', import.meta.url));
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(name = 'playbook-engineering') {
  const base = mkdtempSync(join(tmpdir(), 'playbook-launcher-'));
  roots.push(base);
  const home = join(base, 'home');
  const repo = join(base, name);
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:qwts/playbook-engineering.git'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# playbook\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repo });
  return { base, home, repo };
}

test('selection records an exact clean commit and validates it', () => {
  const { home, repo } = fixture();
  const selected = selectCheckout(repo, { home });
  assert.match(selected.sha, /^[0-9a-f]{40}$/);
  assert.equal(validateSelection({ home }).info.path, realpathSync(repo));
  assert.equal(configPaths(home).selected, join(home, '.config', 'playbook-engineering', 'selected.json'));
});

test('selection rejects a dirty checkout and the wrong remote', () => {
  const dirty = fixture('dirty');
  writeFileSync(join(dirty.repo, 'dirty.txt'), 'dirty\n');
  assert.throws(() => selectCheckout(dirty.repo, { home: dirty.home }), /uncommitted changes/);
  execFileSync('git', ['remote', 'set-url', 'origin', 'git@github.com:someone/else.git'], { cwd: dirty.repo });
  assert.equal(inspectCheckout(dirty.repo), null);
});

test('validation refuses a moved commit until explicitly repinned', () => {
  const { home, repo } = fixture();
  selectCheckout(repo, { home });
  writeFileSync(join(repo, 'README.md'), '# changed\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '--quiet', '-m', 'next'], { cwd: repo });
  assert.match(validateSelection({ home }).error, /moved from/);
  selectCheckout(repo, { home });
  assert.equal(validateSelection({ home }).error, undefined);
});

test('discovery finds valid clones and prunes unavailable registry entries', () => {
  const { base, home, repo } = fixture();
  selectCheckout(repo, { home });
  const registry = configPaths(home).registry;
  writeFileSync(registry, `${JSON.stringify([{ path: '/missing' }, { path: repo }])}\n`);
  assert.deepEqual(discoverCheckouts({ home, roots: [base], depth: 2 }).map((item) => item.path), [realpathSync(repo)]);
});

test('run allowlist rejects absolute paths and traversal', () => {
  assert.equal(approvedEntrypoint('tools/agent-bot/mint-token.mjs'), true);
  assert.equal(approvedEntrypoint('../tools/agent-bot/mint-token.mjs'), false);
  assert.equal(approvedEntrypoint('/tmp/tool.mjs'), false);
  assert.equal(approvedEntrypoint('README.md'), false);
});

test('unattended recovery lists clones and requires an explicit selection', () => {
  const { base, home, repo } = fixture();
  const result = spawnSync(process.execPath, [launcher, 'run', 'tools/agent-bot/mint-token.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PLAYBOOK_SEARCH_ROOTS: base },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Available playbook-engineering checkouts:/);
  assert.match(result.stderr, new RegExp(realpathSync(repo).replaceAll('/', '\\/')));
  assert.match(result.stderr, /playbook-engineering select <path>/);
});

test('unattended recovery tells the user to clone when none exist', () => {
  const base = mkdtempSync(join(tmpdir(), 'playbook-launcher-empty-'));
  roots.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const result = spawnSync(process.execPath, [launcher, 'run', 'tools/agent-bot/mint-token.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PLAYBOOK_SEARCH_ROOTS: base },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no qwts\/playbook-engineering clones found; clone the repository/);
});
