import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  bootstrapGovernedRepos,
  githubRepository,
  parseArgs,
  parseWorktrees,
  refreshExistingRepo,
} from '../bootstrap.mjs';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Bootstrap Test',
  GIT_AUTHOR_EMAIL: 'bootstrap@example.com',
  GIT_COMMITTER_NAME: 'Bootstrap Test',
  GIT_COMMITTER_EMAIL: 'bootstrap@example.com',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'repos-bootstrap-'));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  mkdirSync(seed);
  git(seed, 'init', '--initial-branch=main');
  writeFileSync(path.join(seed, 'README.md'), 'one\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-m', 'initial');
  git(root, 'clone', '--bare', seed, remote);
  git(seed, 'remote', 'add', 'origin', remote);
  return { root, seed, remote };
}

function pushChange(seed, content) {
  writeFileSync(path.join(seed, 'README.md'), content);
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-m', content.trim());
  git(seed, 'push', 'origin', 'main');
}

function writeManifest(root, repos) {
  const manifest = path.join(root, 'repos.json');
  writeFileSync(manifest, JSON.stringify({ account: 'qwts', repos }, null, 2));
  return manifest;
}

function repo(name, status) {
  return {
    name,
    visibility: 'public',
    status,
    sharedCi: false,
    delta: '',
    note: '',
  };
}

test('parseArgs expands the default home and accepts repeatable repo scopes', () => {
  const args = parseArgs(
    ['node', 'bootstrap.mjs', '--code-dir', '~/Fleet', '--repo', 'one', '--repo', 'two'],
    { home: '/tmp/test-home' },
  );
  assert.equal(args.codeDir, '/tmp/test-home/Fleet');
  assert.deepEqual(args.repos, ['one', 'two']);
});

test('parseWorktrees preserves paths with spaces', () => {
  const parsed = parseWorktrees(
    'worktree /tmp/main checkout\nHEAD abc\nbranch refs/heads/main\n\n'
    + 'worktree /tmp/feature\nHEAD def\nbranch refs/heads/feature\n',
  );
  assert.equal(parsed[0].worktree, '/tmp/main checkout');
  assert.equal(parsed[0].branch, 'refs/heads/main');
});

test('githubRepository recognizes common GitHub remote forms without exposing credentials', () => {
  assert.equal(githubRepository('git@github.com:QWTS/overlook.git'), 'qwts/overlook');
  assert.equal(githubRepository('https://token@github.com/qwts/overlook.git'), 'qwts/overlook');
  assert.equal(githubRepository('ssh://git@github.com/qwts/overlook.git'), 'qwts/overlook');
  assert.equal(githubRepository('https://example.com/qwts/overlook.git'), null);
});

test('bootstrap creates the code directory and clones active and onboarding repos only', () => {
  const { root, remote } = fixture();
  const codeDir = path.join(root, 'Code');
  const manifest = writeManifest(root, [
    repo('active-repo', 'active'),
    repo('onboarding-repo', 'onboarding'),
    repo('retired-repo', 'retired'),
  ]);

  const results = bootstrapGovernedRepos({
    manifestPath: manifest,
    codeDir,
    cloneUrlFor: () => remote,
    verifyOrigin: false,
  });

  assert.deepEqual(results.map(({ name, action }) => ({ name, action })), [
    { name: 'active-repo', action: 'cloned' },
    { name: 'onboarding-repo', action: 'cloned' },
  ]);
  assert.ok(existsSync(path.join(codeDir, 'active-repo', '.git')));
  assert.ok(existsSync(path.join(codeDir, 'onboarding-repo', '.git')));
  assert.equal(existsSync(path.join(codeDir, 'retired-repo')), false);
});

test('refresh fast-forwards a clean checked-out main', () => {
  const { root, seed, remote } = fixture();
  const clone = path.join(root, 'clone');
  git(root, 'clone', remote, clone);
  const before = git(clone, 'rev-parse', 'HEAD').trim();
  pushChange(seed, 'two\n');

  const detail = refreshExistingRepo(clone);

  assert.match(detail, /fast-forwarded main/);
  assert.notEqual(git(clone, 'rev-parse', 'HEAD').trim(), before);
  assert.equal(readFileSync(path.join(clone, 'README.md'), 'utf8'), 'two\n');
});

test('refresh updates main without switching or rewriting the checked-out feature branch', () => {
  const { root, seed, remote } = fixture();
  const clone = path.join(root, 'clone');
  git(root, 'clone', remote, clone);
  git(clone, 'switch', '-c', 'feature');
  const featureHead = git(clone, 'rev-parse', 'HEAD').trim();
  pushChange(seed, 'two\n');

  const detail = refreshExistingRepo(clone);

  assert.equal(detail, 'fast-forwarded local main ref');
  assert.equal(git(clone, 'branch', '--show-current').trim(), 'feature');
  assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), featureHead);
  assert.equal(
    git(clone, 'rev-parse', 'refs/heads/main').trim(),
    git(clone, 'rev-parse', 'refs/remotes/origin/main').trim(),
  );
});

test('refresh fast-forwards main in its linked worktree', () => {
  const { root, seed, remote } = fixture();
  const clone = path.join(root, 'clone');
  const mainWorktree = path.join(root, 'main worktree');
  git(root, 'clone', remote, clone);
  git(clone, 'switch', '-c', 'feature');
  git(clone, 'worktree', 'add', mainWorktree, 'main');
  pushChange(seed, 'two\n');

  const detail = refreshExistingRepo(clone);

  assert.match(detail, /fast-forwarded main/);
  assert.equal(readFileSync(path.join(mainWorktree, 'README.md'), 'utf8'), 'two\n');
  assert.equal(git(clone, 'branch', '--show-current').trim(), 'feature');
});

test('refresh refuses a dirty main and preserves its checkout', () => {
  const { root, seed, remote } = fixture();
  const clone = path.join(root, 'clone');
  git(root, 'clone', remote, clone);
  const before = git(clone, 'rev-parse', 'HEAD').trim();
  writeFileSync(path.join(clone, 'local.txt'), 'keep me\n');
  pushChange(seed, 'two\n');

  assert.throws(() => refreshExistingRepo(clone), /main worktree is dirty/);
  assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), before);
  assert.equal(readFileSync(path.join(clone, 'local.txt'), 'utf8'), 'keep me\n');
});

test('refresh reports a dirty main even when it is already current', () => {
  const { root, remote } = fixture();
  const clone = path.join(root, 'clone');
  git(root, 'clone', remote, clone);
  writeFileSync(path.join(clone, 'local.txt'), 'keep me\n');

  assert.throws(() => refreshExistingRepo(clone), /main worktree is dirty/);
  assert.equal(readFileSync(path.join(clone, 'local.txt'), 'utf8'), 'keep me\n');
});

test('refresh preserves an ignored local file that origin/main starts tracking', () => {
  const { root, seed, remote } = fixture();
  const clone = path.join(root, 'clone');
  writeFileSync(path.join(seed, '.gitignore'), 'local.env\n');
  git(seed, 'add', '.gitignore');
  git(seed, 'commit', '-m', 'ignore local environment');
  git(seed, 'push', 'origin', 'main');
  git(root, 'clone', remote, clone);
  const before = git(clone, 'rev-parse', 'HEAD').trim();
  writeFileSync(path.join(clone, 'local.env'), 'local secret\n');

  writeFileSync(path.join(seed, 'local.env'), 'upstream default\n');
  git(seed, 'add', '--force', 'local.env');
  git(seed, 'commit', '-m', 'track environment default');
  git(seed, 'push', 'origin', 'main');

  assert.throws(() => refreshExistingRepo(clone), /would be overwritten by merge/);
  assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), before);
  assert.equal(readFileSync(path.join(clone, 'local.env'), 'utf8'), 'local secret\n');
});

test('refresh refuses an ahead or divergent main without rewriting it', () => {
  const { root, seed, remote } = fixture();
  const clone = path.join(root, 'clone');
  git(root, 'clone', remote, clone);
  writeFileSync(path.join(clone, 'local.txt'), 'local\n');
  git(clone, 'add', 'local.txt');
  git(clone, 'commit', '-m', 'local change');
  const localHead = git(clone, 'rev-parse', 'HEAD').trim();
  pushChange(seed, 'remote change\n');

  assert.throws(() => refreshExistingRepo(clone), /ahead of or diverged/);
  assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), localHead);
  assert.equal(readFileSync(path.join(clone, 'local.txt'), 'utf8'), 'local\n');
});
