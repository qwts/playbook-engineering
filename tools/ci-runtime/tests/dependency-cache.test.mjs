import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dependencyCacheIdentity } from '../../../.github/actions/bounded-dependency-install/cache-key.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dependency-cache-'));
  const root = join(base, 'workspace');
  const runnerTemp = join(base, 'runner-temp');
  mkdirSync(root);
  mkdirSync(runnerTemp);
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  return { base, root, runnerTemp };
}

function identity(fixturePaths, overrides = {}) {
  const { root, runnerTemp } = fixturePaths;
  return dependencyCacheIdentity({
    root,
    ecosystem: 'npm',
    cachePaths: join(runnerTemp, 'ci-dependency-cache/npm'),
    lockfiles: 'package-lock.json',
    toolchainVersion: 'node-22.22.2',
    runnerOs: 'Linux',
    runnerArch: 'X64',
    runnerTemp,
    ...overrides,
  });
}

test('cache identity binds OS, architecture, toolchain, path, and lockfile bytes', () => {
  const paths = fixture();
  const baseline = identity(paths);
  assert.equal(identity(paths), baseline);
  assert.notEqual(identity(paths, { runnerArch: 'ARM64' }), baseline);
  assert.notEqual(identity(paths, { toolchainVersion: 'node-24.0.0' }), baseline);
  assert.notEqual(
    identity(paths, { cachePaths: join(paths.runnerTemp, 'ci-dependency-cache/npm/alternate') }),
    baseline,
  );
  writeFileSync(join(paths.root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  assert.notEqual(identity(paths), baseline);
});

test('cache identity accepts only the ecosystem runner-temp subtree', () => {
  const paths = fixture();
  assert.throws(
    () => identity(paths, { cachePaths: join(paths.runnerTemp, 'ci-dependency-cache/npm/node_modules') }),
    /forbidden component node_modules/u,
  );
  assert.throws(
    () => identity(paths, { cachePaths: join(paths.runnerTemp, 'ci-dependency-cache/npm/target') }),
    /forbidden component target/u,
  );
  assert.throws(() => identity(paths, { cachePaths: paths.root }), /outside the repository workspace/u);
  assert.throws(() => identity(paths, { cachePaths: '~/.npm' }), /must be absolute/u);
  assert.throws(
    () => identity(paths, { cachePaths: join(paths.runnerTemp, 'ci-dependency-cache/npm/.ssh') }),
    /forbidden component \.ssh/u,
  );
  assert.throws(
    () => identity(paths, { cachePaths: join(paths.runnerTemp, 'ci-dependency-cache/cargo') }),
    /must stay under/u,
  );
  assert.throws(() => identity(paths, { cachePaths: '/' }), /too broad/u);
});

test('cache identity requires exact toolchain and lockfile inputs', () => {
  const paths = fixture();
  assert.throws(() => identity(paths, { toolchainVersion: 'latest' }), /must be exact/u);
  assert.throws(() => identity(paths, { lockfiles: '../package-lock.json' }), /escapes/u);
  assert.throws(() => identity(paths, { lockfiles: '*.lock' }), /exact repository-relative/u);
  const outside = join(paths.base, 'outside-lock.json');
  writeFileSync(outside, '{}\n');
  rmSync(join(paths.root, 'package-lock.json'));
  symlinkSync(outside, join(paths.root, 'package-lock.json'));
  assert.throws(() => identity(paths), /not a regular file/u);
});

test('post-install validation requires a real cache directory in runner custody', () => {
  const paths = fixture();
  const cachePath = join(paths.runnerTemp, 'ci-dependency-cache/npm');
  assert.throws(() => identity(paths, { requireCachePaths: true }), /was not created/u);
  mkdirSync(cachePath, { recursive: true });
  assert.doesNotThrow(() => identity(paths, { requireCachePaths: true }));
  rmSync(cachePath, { recursive: true });
  const outside = join(paths.runnerTemp, 'credential-store');
  mkdirSync(outside);
  symlinkSync(outside, cachePath, 'dir');
  assert.throws(() => identity(paths, { requireCachePaths: true }), /real directory/u);
});

test('composite action restores before install and saves only after trusted main pushes', () => {
  const action = readFileSync(
    new URL('../../../.github/actions/bounded-dependency-install/action.yml', import.meta.url),
    'utf8',
  );
  const restore = action.indexOf('uses: actions/cache/restore@');
  const install = action.indexOf('Run bounded dependency installer');
  const revalidate = action.indexOf('Revalidate dependency cache identity and path custody');
  const save = action.indexOf('uses: actions/cache/save@');
  assert.ok(restore >= 0 && restore < install && install < revalidate && revalidate < save);
  assert.match(action, /CACHE_EXPECTED_KEY: \$\{\{ steps\.identity\.outputs\.key \}\}/u);
  assert.match(action, /CACHE_REQUIRE_PATHS_PRESENT: 'true'/u);
  assert.match(action, /github\.event_name == 'push'/u);
  assert.match(action, /github\.event\.repository\.default_branch/u);
  assert.doesNotMatch(action, /restore-keys:/u);
});

test('reference CI disables implicit setup-node caching and fixes npm cache custody', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /package-manager-cache: false/u);
  assert.match(workflow, /NPM_CONFIG_CACHE: \$\{\{ runner\.temp \}\}\/ci-dependency-cache\/npm/u);
  assert.match(workflow, /cache-paths: \$\{\{ runner\.temp \}\}\/ci-dependency-cache\/npm/u);
  assert.doesNotMatch(workflow, /npm config get cache/u);
});
