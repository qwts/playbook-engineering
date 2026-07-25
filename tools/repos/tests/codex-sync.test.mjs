import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GOVERNED_CODEX_FILES } from '../lib/baseline-files.mjs';
import {
  CODEX_SYNC_BRANCH,
  CODEX_SYNC_TITLE,
  chooseSyncHead,
  diffManagedFiles,
  gitBlobSha,
  managedCodexPaths,
  syncPullBody,
} from '../lib/codex-sync.mjs';
import { syncRepository } from '../sync-codex.mjs';

function canonical(path, content = 'canonical\n', mode = '100644') {
  const bytes = Buffer.from(content);
  return { path, content: bytes, sha: gitBlobSha(bytes), mode };
}

test('managed diff detects missing, changed, and mode-only drift', () => {
  const files = new Map([
    ['a', canonical('a')],
    ['b', canonical('b')],
    ['c', canonical('c', 'executable\n', '100755')],
    ['d', canonical('d')],
  ]);
  const tree = new Map([
    ['a', { path: 'a', type: 'blob', sha: files.get('a').sha, mode: '100644' }],
    ['b', { path: 'b', type: 'blob', sha: gitBlobSha('different\n'), mode: '100644' }],
    ['c', { path: 'c', type: 'blob', sha: files.get('c').sha, mode: '100644' }],
  ]);
  assert.deepEqual(
    diffManagedFiles(files, tree, ['a', 'b', 'c', 'd']).map((file) => file.path),
    ['b', 'c', 'd'],
  );
});

test('manifest exclusions remove files from the managed set', () => {
  const excluded = GOVERNED_CODEX_FILES[2];
  const paths = managedCodexPaths({ codexSync: { exclude: [excluded] } });
  assert.equal(paths.length, GOVERNED_CODEX_FILES.length - 1);
  assert.ok(!paths.includes(excluded));
  assert.deepEqual(managedCodexPaths({ codexSync: { enabled: false } }), []);
});

test('an open stable-branch pull request is reused without resetting its branch', () => {
  const pull = {
    number: 12,
    state: 'open',
    title: CODEX_SYNC_TITLE,
    head: { ref: CODEX_SYNC_BRANCH },
  };
  assert.deepEqual(
    chooseSyncHead({
      baseSha: 'base',
      branchSha: 'branch',
      pulls: [pull],
    }),
    { parentSha: 'branch', pull, resetBranch: false },
  );
});

test('a stale stable branch is reset only when no pull request is open', () => {
  assert.deepEqual(
    chooseSyncHead({
      baseSha: 'base',
      branchSha: 'stale',
      pulls: [{
        number: 11,
        state: 'closed',
        title: CODEX_SYNC_TITLE,
        head: { ref: CODEX_SYNC_BRANCH },
      }],
    }),
    { parentSha: 'base', pull: null, resetBranch: true },
  );
});

test('an unowned stable branch is never deleted', () => {
  assert.throws(
    () => chooseSyncHead({
      baseSha: 'base',
      branchSha: 'unknown',
      pulls: [],
    }),
    /refusing to reset unowned branch/,
  );
});

test('an orphaned bot sync branch can be recovered after a partial failure', () => {
  assert.deepEqual(
    chooseSyncHead({
      baseSha: 'base',
      branchSha: 'orphaned',
      branchOwned: true,
      pulls: [],
    }),
    { parentSha: 'base', pull: null, resetBranch: true },
  );
});

test('a current existing pull request is a no-write synchronization result', async () => {
  const path = GOVERNED_CODEX_FILES[0];
  const source = canonical(path);
  const files = new Map([[path, source]]);
  const exclude = GOVERNED_CODEX_FILES.filter((candidate) => candidate !== path);
  const writes = [];
  const calls = [];
  const client = {
    async call(method, requestPath) {
      calls.push([method, requestPath]);
      if (method !== 'GET') writes.push([method, requestPath]);
      if (requestPath === '/repos/qwts/target') return { default_branch: 'main' };
      if (requestPath.endsWith('/git/ref/heads/main')) return { object: { sha: 'base-sha' } };
      if (requestPath.endsWith('/git/commits/base-sha')) return { tree: { sha: 'base-tree' } };
      if (requestPath.endsWith('/git/trees/base-tree?recursive=1')) return { tree: [], truncated: false };
      if (requestPath.includes('/pulls?state=all')) {
        return [{
          number: 7,
          state: 'open',
          title: CODEX_SYNC_TITLE,
          html_url: 'https://example.test/pr/7',
          head: { ref: CODEX_SYNC_BRANCH },
        }];
      }
      if (requestPath.endsWith('/git/ref/heads/governance/codex-sync')) {
        return { object: { sha: 'branch-sha' } };
      }
      if (requestPath.endsWith('/git/commits/branch-sha')) return { tree: { sha: 'branch-tree' } };
      if (requestPath.endsWith('/git/trees/branch-tree?recursive=1')) {
        return {
          truncated: false,
          tree: [{ path, type: 'blob', sha: source.sha, mode: source.mode }],
        };
      }
      throw new Error(`unexpected request: ${method} ${requestPath}`);
    },
  };

  const result = await syncRepository(client, {
    owner: 'qwts',
    entry: { name: 'target', codexSync: { exclude } },
    canonicalFiles: files,
    sourceSha: 'a'.repeat(40),
    apply: true,
  });
  assert.equal(result.status, 'pull-current');
  assert.equal(result.pull, 'https://example.test/pr/7');
  assert.deepEqual(writes, []);
  assert.ok(calls.some(([, requestPath]) => requestPath.includes('/pulls?state=all')));
});

test('pull body records source provenance and every managed path', () => {
  const body = syncPullBody({
    owner: 'qwts',
    sourceSha: 'a'.repeat(40),
    paths: GOVERNED_CODEX_FILES,
  });
  assert.match(body, /playbook-engineering\/commit\/a{40}/);
  assert.match(body, /playbook-engineering#60/);
  for (const path of GOVERNED_CODEX_FILES) assert.match(body, new RegExp(path.replaceAll('.', '\\.')));
});
