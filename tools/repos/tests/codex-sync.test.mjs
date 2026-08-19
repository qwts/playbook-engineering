import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  GOVERNED_FORMAT_EXEMPT_FILES,
  GOVERNED_HARNESS_FILES,
} from '../lib/baseline-files.mjs';
import {
  CODEX_REVIEW_BOT,
  CODEX_SYNC_BOT,
  CODEX_SYNC_BRANCH,
  CODEX_SYNC_TITLE,
  COPILOT_REVIEW_BOT,
  assertHumanLogin,
  chooseSyncHead,
  cleanAiReviewEvidence,
  diffManagedFiles,
  gitBlobSha,
  materializeManagedFiles,
  MANAGED_TEXT_BLOCKS,
  mergeManagedFile,
  managedCodexPaths,
  preferredMergeFlag,
  syncPullBody,
  validateSyncApprovalCandidate,
} from '../lib/codex-sync.mjs';
import { parseArgs, reviewRepository } from '../approve-codex-sync.mjs';
import { installationToken, syncRepository } from '../sync-codex.mjs';

function canonical(path, content = 'canonical\n', mode = '100644') {
  const bytes = Buffer.from(content);
  return { path, content: bytes, sha: gitBlobSha(bytes), mode };
}

test('governed harness workflow mints a least-privilege chores-dumb token', () => {
  const workflow = readFileSync('.github/workflows/codex-sync.yml', 'utf8');

  assert.match(workflow, /name: Governed harness sync/u);
  assert.match(workflow, /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/u);
  assert.match(workflow, /client-id: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID \}\}/u);
  assert.match(workflow, /private-key: \$\{\{ secrets\.CHORES_DUMB_PRIVATE_KEY \}\}/u);
  assert.match(workflow, /permission-contents: write/u);
  assert.match(workflow, /permission-pull-requests: write/u);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/u);
  assert.doesNotMatch(workflow, /CODEX_AGENT_|\bapp-id:|permission-(?:attestations|packages):/u);
});

test('the push trigger covers every governed harness path, so no fix ships only on the weekly run', () => {
  const workflow = readFileSync('.github/workflows/codex-sync.yml', 'utf8');
  // The `paths:` list under `on.push`, up to the next top-level trigger key.
  const pushBlock = workflow.slice(workflow.indexOf('push:'), workflow.indexOf('workflow_dispatch:'));
  const patterns = [...pushBlock.matchAll(/^\s+-\s+'([^']+)'$/gmu)].map((m) => m[1]);
  const covers = (pattern, file) => {
    if (pattern === file) return true;
    if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
    return false;
  };
  const uncovered = GOVERNED_HARNESS_FILES.filter((file) => !patterns.some((pattern) => covers(pattern, file)));
  assert.deepEqual(uncovered, [], `governed paths with no push-trigger glob will not propagate until the weekly run: ${uncovered.join(', ')}`);
});

test('apply requires an explicit chores-dumb token while dry-run may mint read credentials', async () => {
  await assert.rejects(
    installationToken({ apply: true, env: {} }),
    new RegExp(`requires a GH_TOKEN for ${CODEX_SYNC_BOT}\\[bot\\]`),
  );
  assert.equal(
    await installationToken({ apply: true, env: { GH_TOKEN: 'runtime-token' } }),
    'runtime-token',
  );
  assert.equal(
    await installationToken({
      apply: false,
      env: {},
      mintToken: async ({ env }) => {
        assert.deepEqual(env, {});
        return { token: 'read-token' };
      },
    }),
    'read-token',
  );
});

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

test('the governed formatter block covers the exact byte-managed inventory', () => {
  const source = readFileSync('.prettierignore', 'utf8');
  const markers = MANAGED_TEXT_BLOCKS.get('.prettierignore');
  const begin = source.indexOf(markers.begin);
  const end = source.indexOf(markers.end);
  assert.ok(begin >= 0 && end > begin);
  const lines = new Set(source.slice(begin, end).split(/\r?\n/u));

  assert.deepEqual(
    GOVERNED_FORMAT_EXEMPT_FILES.filter((path) => !lines.has(path)),
    [],
    'every governed byte path must be exempt from downstream formatters',
  );
  assert.deepEqual(
    [...lines].filter((line) => GOVERNED_FORMAT_EXEMPT_FILES.includes(line) === false && /^(?:\.|governance\/|tools\/)/u.test(line)),
    [],
    'the format block must not retain paths outside the governed inventory',
  );
});

test('managed formatter composition preserves repository rules and updates only its block', async () => {
  const pathname = '.prettierignore';
  const source = canonical(pathname, readFileSync(pathname, 'utf8'));
  const stale = [
    'dist/',
    'repo-owned-generated/',
    '',
    '# governed:agent-harness-format:start',
    'stale-managed-path',
    '# governed:agent-harness-format:end',
    '',
    'coverage/',
  ].join('\n');
  const targetContent = Buffer.from(stale);
  const target = new Map([[pathname, {
    path: pathname,
    type: 'blob',
    sha: gitBlobSha(targetContent),
    mode: '100644',
  }]]);

  const files = await materializeManagedFiles(
    new Map([[pathname, source]]),
    target,
    [pathname],
    async () => targetContent,
  );
  const first = files.get(pathname);
  const second = mergeManagedFile(source, first.content);
  const merged = first.content.toString('utf8');

  assert.match(merged, /^dist\/\nrepo-owned-generated\//u);
  assert.match(merged, /\ncoverage\/$/u);
  assert.doesNotMatch(merged, /stale-managed-path/u);
  assert.equal(first.content.toString('utf8'), second.content.toString('utf8'));
});

test('managed formatter composition appends once and fails closed on marker corruption', () => {
  const pathname = '.prettierignore';
  const source = canonical(pathname, readFileSync(pathname, 'utf8'));
  const appended = mergeManagedFile(source, Buffer.from('dist/\n'));

  assert.match(appended.content.toString('utf8'), /^dist\/\n\n# governed:agent-harness-format:start/um);
  assert.throws(
    () => mergeManagedFile(source, Buffer.from([
      '# governed:agent-harness-format:start',
      'stale',
      '# governed:agent-harness-format:start',
      '# governed:agent-harness-format:end',
    ].join('\n'))),
    /must contain exactly one ordered/u,
  );
});

test('a missing formatter file receives only the governed block', () => {
  const pathname = '.prettierignore';
  const block = readFileSync(pathname, 'utf8');
  const source = canonical(pathname, `playbook-only-ignore/\n\n${block}`);
  const merged = mergeManagedFile(source, null).content.toString('utf8');

  assert.match(merged, /^# governed:agent-harness-format:start/u);
  assert.doesNotMatch(merged, /playbook-only-ignore/u);
});

test('managed JSON overlays preserve repository-owned agent harness configuration', async () => {
  const path = '.claude/settings.json';
  const source = canonical(path, JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    hooks: {
      // Governance-owned since ENG-0138: the memory guard is only a fleet
      // control if every repo's hook wiring comes from here.
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'managed-guard' }] }],
      WorktreeCreate: [{ hooks: [{ type: 'command', command: 'managed' }] }],
    },
  }));
  const targetContent = Buffer.from(JSON.stringify({
    permissions: { defaultMode: 'acceptEdits' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'stale-local-guard' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'repo-session' }] }],
      WorktreeCreate: [{ hooks: [{ type: 'command', command: 'stale' }] }],
    },
  }));
  const target = new Map([[path, {
    path,
    type: 'blob',
    sha: gitBlobSha(targetContent),
    mode: '100644',
  }]]);

  const files = await materializeManagedFiles(
    new Map([[path, source]]),
    target,
    [path],
    async () => targetContent,
  );
  const merged = JSON.parse(files.get(path).content.toString('utf8'));

  assert.deepEqual(merged.permissions, { defaultMode: 'acceptEdits' });
  // A repo cannot keep a local edit of a governed hook: the guard wiring is
  // the one thing a drifting downstream copy would silently disable.
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'managed-guard');
  assert.deepEqual(merged.hooks.Notification, [{
    hooks: [{ type: 'command', command: 'repo-session' }],
  }]);
  assert.equal(Object.hasOwn(merged.hooks, 'SessionStart'), false);
  assert.equal(merged.hooks.WorktreeCreate[0].hooks[0].command, 'managed');
  assert.equal(files.get(path).mode, source.mode);
});

test('canonical Claude settings declare ownership for every hook event they ship', () => {
  const path = '.claude/settings.json';
  const content = readFileSync(new URL('../../../.claude/settings.json', import.meta.url));
  const source = { path, content, sha: gitBlobSha(content), mode: '100644' };
  assert.doesNotThrow(() => mergeManagedFile(source, null));
});

test('managed JSON overlays fail closed for malformed downstream configuration', () => {
  const source = canonical('.claude/settings.json', '{}\n');
  assert.throws(
    () => mergeManagedFile(source, Buffer.from('{broken')),
    /invalid downstream JSON/,
  );
});

test('managed JSON ownership propagates deletions without removing repository hooks', () => {
  const source = canonical('.claude/settings.json', JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
  }));
  const target = Buffer.from(JSON.stringify({
    hooks: {
      Notification: [{ hooks: [{ type: 'command', command: 'repo-session' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'stale-session' }] }],
      PreToolUse: [{ matcher: 'Bash' }],
      WorktreeCreate: [{ hooks: [{ type: 'command', command: 'obsolete' }] }],
    },
  }));
  const merged = JSON.parse(mergeManagedFile(source, target).content.toString('utf8'));

  // Repo-owned hooks survive; governed ones the canonical file no longer
  // declares are removed rather than left behind as orphans.
  assert.deepEqual(merged.hooks.Notification, [{ hooks: [{ type: 'command', command: 'repo-session' }] }]);
  assert.equal(Object.hasOwn(merged.hooks, 'SessionStart'), false);
  assert.equal(Object.hasOwn(merged.hooks, 'PreToolUse'), false);
  assert.equal(Object.hasOwn(merged.hooks, 'WorktreeCreate'), false);
});

test('manifest-declared composition preserves generated hook adapters exactly once', () => {
  const marker = 'agent-bot agent-hook';
  const generated = (event) => ({
    hooks: [{ type: 'command', command: `agent-hook --event ${event} # ${marker}` }],
  });
  const options = { preserveArrayEntriesContaining: [marker] };
  const cases = [
    {
      path: '.codex/hooks.json',
      source: {
        description: 'current shared policy',
        hooks: { PreToolUse: [{ hooks: [{ command: 'current-codex-guard' }] }] },
      },
      target: {
        description: 'stale shared policy',
        hooks: {
          PreToolUse: [
            { hooks: [{ command: 'stale-codex-guard' }] },
            generated('pre-tool-use'),
            generated('pre-tool-use'),
          ],
          SessionStart: [generated('session-start')],
        },
      },
      sharedEvent: 'PreToolUse',
      sharedCommand: 'current-codex-guard',
    },
    {
      path: '.cursor/hooks.json',
      source: {
        version: 1,
        hooks: { beforeShellExecution: [{ command: 'current-cursor-guard' }] },
      },
      target: {
        version: 1,
        hooks: {
          beforeShellExecution: [
            { command: 'stale-cursor-guard' },
            { command: `agent-hook --event pre-command # ${marker}` },
            { command: `agent-hook --event pre-command # ${marker}` },
          ],
          sessionStart: [{ command: `agent-hook --event session-start # ${marker}` }],
        },
      },
      sharedEvent: 'beforeShellExecution',
      sharedCommand: 'current-cursor-guard',
    },
  ];

  for (const fixture of cases) {
    const source = canonical(fixture.path, `${JSON.stringify(fixture.source, null, 2)}\n`);
    const target = Buffer.from(`${JSON.stringify(fixture.target, null, 2)}\n`);
    const first = mergeManagedFile(source, target, options);
    const second = mergeManagedFile(source, first.content, options);
    const merged = JSON.parse(first.content.toString('utf8'));
    const shared = merged.hooks[fixture.sharedEvent];

    assert.equal(first.content.toString('utf8'), second.content.toString('utf8'), fixture.path);
    assert.match(JSON.stringify(shared[0]), new RegExp(fixture.sharedCommand));
    assert.equal(shared.filter((entry) => JSON.stringify(entry).includes(marker)).length, 1);
    assert.equal(JSON.stringify(merged).includes('stale-'), false);
  }
});

test('Claude composition keeps repo configuration while replacing governed hooks', () => {
  const path = '.claude/settings.json';
  const marker = 'agent-bot agent-hook';
  const generated = (event) => ({
    hooks: [{ type: 'command', command: `agent-hook --event ${event} # ${marker}` }],
  });
  const source = canonical(path, `${JSON.stringify({
    $schema: 'current-schema',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'current-guard' }] }],
      WorktreeCreate: [{ hooks: [{ command: 'current-worktree' }] }],
    },
  }, null, 2)}\n`);
  const target = Buffer.from(`${JSON.stringify({
    permissions: { defaultMode: 'acceptEdits' },
    hooks: {
      WorktreeCreate: [{ hooks: [{ command: 'stale-worktree' }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ command: 'stale-guard' }] },
        generated('pre-tool-use'),
        generated('pre-tool-use'),
      ],
      SessionStart: [generated('session-start')],
    },
  }, null, 2)}\n`);
  const options = { preserveArrayEntriesContaining: [marker] };
  const first = mergeManagedFile(source, target, options);
  const second = mergeManagedFile(source, first.content, options);
  const merged = JSON.parse(first.content.toString('utf8'));

  assert.equal(first.content.toString('utf8'), second.content.toString('utf8'));
  assert.deepEqual(merged.permissions, { defaultMode: 'acceptEdits' });
  assert.equal(merged.$schema, 'current-schema');
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'current-guard');
  assert.equal(merged.hooks.PreToolUse.filter((entry) => JSON.stringify(entry).includes(marker)).length, 1);
  assert.equal(merged.hooks.WorktreeCreate[0].hooks[0].command, 'current-worktree');
  assert.equal(merged.hooks.SessionStart.length, 1);
});

test('composition rejects arrays that collide with canonical non-array paths', () => {
  const marker = 'agent-bot agent-hook';
  const source = canonical('.codex/hooks.json', `${JSON.stringify({
    hooks: {
      PreToolUse: [{ command: 'managed-guard' }],
    },
  }, null, 2)}\n`);
  const target = Buffer.from(`${JSON.stringify({
    hooks: [{ command: marker }],
  }, null, 2)}\n`);

  assert.throws(
    () => mergeManagedFile(source, target, { preserveArrayEntriesContaining: [marker] }),
    /preserved array path hooks collides with canonical non-array value/,
  );
});

test('composition rejects prototype-sensitive paths without mutating prototypes', () => {
  const marker = 'agent-bot agent-hook';
  const source = canonical('.codex/hooks.json', '{}\n');
  const target = Buffer.from(`{"__proto__":{"polluted":[{"command":"${marker}"}]}}\n`);

  assert.throws(
    () => mergeManagedFile(source, target, { preserveArrayEntriesContaining: [marker] }),
    /prototype-sensitive JSON path segment "__proto__"/,
  );
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('managed JSON overlays reject canonical keys without declared ownership', () => {
  const source = canonical('.claude/settings.json', JSON.stringify({
    permissions: { defaultMode: 'acceptEdits' },
  }));
  assert.throws(
    () => mergeManagedFile(source),
    /permissions\.defaultMode has no managed ownership/,
  );
});

test('manifest exclusions remove files from the managed set', () => {
  const excluded = GOVERNED_HARNESS_FILES[2];
  const paths = managedCodexPaths({ codexSync: { exclude: [excluded] } });
  assert.equal(paths.length, GOVERNED_HARNESS_FILES.length - 1);
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
  const path = GOVERNED_HARNESS_FILES[0];
  const source = canonical(path);
  const files = new Map([[path, source]]);
  const exclude = GOVERNED_HARNESS_FILES.filter((candidate) => candidate !== path);
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
      if (requestPath.endsWith('/git/ref/heads/governance/harness-sync')) {
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

test('an open sync pull repairs a JSON overlay from the target default branch', async () => {
  const path = '.claude/settings.json';
  const source = canonical(path, `${JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'managed-guard' }] }],
      WorktreeCreate: [{ hooks: [{ type: 'command', command: 'managed' }] }],
    },
  }, null, 2)}\n`);
  const baseContent = Buffer.from(`${JSON.stringify({
    permissions: { defaultMode: 'acceptEdits' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'stale-local-guard' }] }],
      // Repository-generated projection owned by the target manifest entry.
      GeneratedHook: [{ hooks: [{ type: 'command', command: 'agent-bot agent-hook' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'repo-session' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'stale-session' }] }],
      WorktreeCreate: [{ hooks: [{ type: 'command', command: 'managed' }] }],
    },
  }, null, 2)}\n`);
  const baseEntry = {
    path,
    type: 'blob',
    sha: gitBlobSha(baseContent),
    mode: '100644',
  };
  let uploaded = null;
  const client = {
    async call(method, requestPath, body) {
      if (method === 'GET' && requestPath === '/repos/qwts/target') {
        return { default_branch: 'main' };
      }
      if (method === 'GET' && requestPath.endsWith('/git/ref/heads/main')) {
        return { object: { sha: 'base-sha' } };
      }
      if (method === 'GET' && requestPath.endsWith('/git/commits/base-sha')) {
        return { tree: { sha: 'base-tree' } };
      }
      if (method === 'GET' && requestPath.endsWith('/git/trees/base-tree?recursive=1')) {
        return { tree: [baseEntry], truncated: false };
      }
      if (method === 'GET' && requestPath.endsWith(`/git/blobs/${baseEntry.sha}`)) {
        return { encoding: 'base64', content: baseContent.toString('base64') };
      }
      if (method === 'GET' && requestPath.includes('/pulls?state=all')) {
        return [{
          number: 7,
          state: 'open',
          title: CODEX_SYNC_TITLE,
          html_url: 'https://example.test/pr/7',
          head: { ref: CODEX_SYNC_BRANCH },
        }];
      }
      if (method === 'GET' && requestPath.endsWith('/git/ref/heads/governance/harness-sync')) {
        return { object: { sha: 'branch-sha' } };
      }
      if (method === 'GET' && requestPath.endsWith('/git/commits/branch-sha')) {
        return { tree: { sha: 'branch-tree' } };
      }
      if (method === 'GET' && requestPath.endsWith('/git/trees/branch-tree?recursive=1')) {
        return {
          truncated: false,
          tree: [{ path, type: 'blob', sha: source.sha, mode: source.mode }],
        };
      }
      if (method === 'POST' && requestPath.endsWith('/git/blobs')) {
        uploaded = Buffer.from(body.content, 'base64');
        return { sha: 'merged-blob' };
      }
      if (method === 'POST' && requestPath.endsWith('/git/trees')) {
        return { sha: 'merged-tree' };
      }
      if (method === 'POST' && requestPath.endsWith('/git/commits')) {
        assert.deepEqual(body.parents, ['branch-sha']);
        return { sha: 'merged-commit' };
      }
      if (
        method === 'PATCH' &&
        requestPath.endsWith('/git/refs/heads/governance/harness-sync')
      ) {
        return {};
      }
      if (method === 'PATCH' && requestPath.endsWith('/pulls/7')) {
        return { html_url: 'https://example.test/pr/7' };
      }
      throw new Error(`unexpected request: ${method} ${requestPath}`);
    },
  };

  const result = await syncRepository(client, {
    owner: 'qwts',
    entry: {
      name: 'target',
      codexSync: {
        exclude: GOVERNED_HARNESS_FILES.filter((candidate) => candidate !== path),
        preserveJsonArrayEntries: {
          [path]: ['agent-bot agent-hook'],
        },
      },
    },
    canonicalFiles: new Map([[path, source]]),
    sourceSha: 'a'.repeat(40),
    apply: true,
  });
  const merged = JSON.parse(uploaded.toString('utf8'));

  assert.equal(result.status, 'pull-updated');
  assert.deepEqual(merged.permissions, { defaultMode: 'acceptEdits' });
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'managed-guard');
  assert.deepEqual(merged.hooks.Notification, [{
    hooks: [{ type: 'command', command: 'repo-session' }],
  }]);
  assert.equal(Object.hasOwn(merged.hooks, 'SessionStart'), false);
  assert.deepEqual(merged.hooks.GeneratedHook, [{
    hooks: [{ type: 'command', command: 'agent-bot agent-hook' }],
  }]);
  assert.equal(merged.hooks.WorktreeCreate[0].hooks[0].command, 'managed');
});

test('pull body records source provenance and every managed path', () => {
  const body = syncPullBody({
    owner: 'qwts',
    sourceSha: 'a'.repeat(40),
    paths: GOVERNED_HARNESS_FILES,
  });
  assert.match(body, /playbook-engineering\/commit\/a{40}/);
  assert.match(body, /playbook-engineering#60/);
  for (const path of GOVERNED_HARNESS_FILES) assert.match(body, new RegExp(path.replaceAll('.', '\\.')));
});

function approvalFixture(overrides = {}) {
  const fullName = 'qwts/target';
  const pull = {
    number: 7,
    title: CODEX_SYNC_TITLE,
    body: `Source: https://github.com/qwts/playbook-engineering/commit/${'a'.repeat(40)}`,
    html_url: 'https://github.com/qwts/target/pull/7',
    draft: false,
    auto_merge: null,
    user: { login: `${CODEX_SYNC_BOT}[bot]`, type: 'Bot' },
    head: { ref: CODEX_SYNC_BRANCH, sha: 'head-sha', repo: { full_name: fullName } },
    base: { ref: 'main', repo: { full_name: fullName } },
    ...overrides,
  };
  return {
    owner: 'qwts',
    entry: { name: 'target' },
    metadata: {
      full_name: fullName,
      default_branch: 'main',
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    },
    pull,
    files: [{ filename: GOVERNED_HARNESS_FILES[0], status: 'modified' }],
  };
}

test('approval validation accepts only the exact bot-owned managed sync shape', () => {
  const fixture = approvalFixture();
  assert.deepEqual(validateSyncApprovalCandidate(fixture), []);

  const errors = validateSyncApprovalCandidate({
    ...fixture,
    pull: {
      ...fixture.pull,
      user: { login: 'human', type: 'User' },
    },
    files: [{ filename: 'src/application.mjs', status: 'modified' }],
  });
  assert.ok(errors.some((error) => error.includes(`author must be ${CODEX_SYNC_BOT}[bot]`)));
  assert.ok(errors.some((error) => error.includes('unmanaged changed path')));
});

test('human identity and repository merge method selection fail closed', () => {
  assert.equal(assertHumanLogin('qwts'), 'qwts');
  assert.throws(() => assertHumanLogin(`${CODEX_SYNC_BOT}[bot]`), /requires a human/);
  assert.equal(preferredMergeFlag({ allow_merge_commit: true }), '--merge');
  assert.equal(preferredMergeFlag({ allow_squash_merge: true }), '--squash');
  assert.equal(preferredMergeFlag({ allow_rebase_merge: true }), '--rebase');
  assert.throws(() => preferredMergeFlag({ full_name: 'qwts/target' }), /no repository merge method/);
});

test('clean AI review evidence is current-head and finding-free', () => {
  const headCommittedAt = '2026-07-25T10:00:00Z';
  assert.deepEqual(
    cleanAiReviewEvidence({
      headSha: 'head-sha',
      headCommittedAt,
      issueReactions: [{
        content: '+1',
        created_at: '2026-07-25T10:01:00Z',
        user: { login: CODEX_REVIEW_BOT },
      }],
    }).map((evidence) => evidence.provider),
    ['codex'],
  );
  assert.deepEqual(
    cleanAiReviewEvidence({
      headSha: 'head-sha',
      headCommittedAt,
      commentReactions: [{
        content: '+1',
        created_at: '2026-07-25T10:01:00Z',
        parentBody: '@codex fix the tests',
        user: { login: CODEX_REVIEW_BOT },
      }],
    }),
    [],
  );

  const copilotReview = {
    id: 42,
    state: 'COMMENTED',
    commit_id: 'head-sha',
    submitted_at: '2026-07-25T10:01:00Z',
    user: { login: COPILOT_REVIEW_BOT },
  };
  assert.deepEqual(
    cleanAiReviewEvidence({
      headSha: 'head-sha',
      headCommittedAt,
      reviews: [copilotReview],
    }).map((evidence) => evidence.provider),
    ['copilot'],
  );
  assert.deepEqual(
    cleanAiReviewEvidence({
      headSha: 'head-sha',
      headCommittedAt,
      reviews: [copilotReview],
      reviewComments: [{ pull_request_review_id: copilotReview.id }],
      issueReactions: [{
        content: '+1',
        created_at: '2026-07-25T09:59:00Z',
        user: { login: CODEX_REVIEW_BOT },
      }],
    }),
    [],
  );
});

test('approval helper arguments keep dry-run and explicit apply distinct', () => {
  assert.deepEqual(
    parseArgs(['--repo', 'overlook', '--json']),
    {
      apply: false,
      requestReviews: false,
      json: true,
      repo: 'overlook',
      help: false,
    },
  );
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--request-reviews']).requestReviews, true);
  assert.throws(
    () => parseArgs(['--request-reviews', '--apply']),
    /separate phases/,
  );
  assert.throws(() => parseArgs(['--repo']), /requires a repository name/);
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
});

test('human review-request mode posts once for the current head', () => {
  const fixture = approvalFixture();
  const runs = [];
  const client = {
    json(args) {
      const path = args[1];
      if (path === '/repos/qwts/target') return fixture.metadata;
      if (path === '/repos/qwts/target/pulls/7') return fixture.pull;
      if (path === '/repos/qwts/target/commits/head-sha') {
        return { commit: { committer: { date: '2026-07-25T10:00:00Z' } } };
      }
      throw new Error(`unexpected json request: ${args.join(' ')}`);
    },
    pages(path) {
      if (path.includes('pulls?state=open')) return [fixture.pull];
      if (path.endsWith('/files?per_page=100')) return fixture.files;
      if (path.endsWith('/reviews?per_page=100')) return [];
      if (path.endsWith('/comments?per_page=100')) return [];
      if (path.endsWith('/reactions?per_page=100')) return [];
      throw new Error(`unexpected paged request: ${path}`);
    },
    run(args) {
      runs.push(args);
    },
  };

  const result = reviewRepository(client, {
    owner: fixture.owner,
    entry: fixture.entry,
    actor: 'qwts',
    apply: false,
    requestReviews: true,
  });
  assert.equal(result.status, 'review-requested');
  assert.deepEqual(runs, [[
    'pr',
    'comment',
    '7',
    '--repo',
    'qwts/target',
    '--body',
    '@codex review',
  ]]);
});

test('human review-request mode deduplicates across humans with write permission', () => {
  const fixture = approvalFixture();
  const runs = [];
  const currentRequest = {
    id: 99,
    created_at: '2026-07-25T10:01:00Z',
    user: { login: 'other-reviewer', type: 'User' },
    author_association: 'COLLABORATOR',
    body: '@codex review',
  };
  const client = {
    json(args) {
      if (args[1] === '/repos/qwts/target') return fixture.metadata;
      if (args[1] === '/repos/qwts/target/commits/head-sha') {
        return { commit: { committer: { date: '2026-07-25T10:00:00Z' } } };
      }
      if (args[1] === '/repos/qwts/target/collaborators/other-reviewer/permission') {
        return { permission: 'write' };
      }
      return fixture.pull;
    },
    pages(path) {
      if (path.includes('pulls?state=open')) return [fixture.pull];
      if (path.endsWith('/files?per_page=100')) return fixture.files;
      if (path.includes('/issues/7/comments')) return [currentRequest];
      if (path.endsWith('/reviews?per_page=100')) return [];
      if (path.endsWith('/comments?per_page=100')) return [];
      if (path.endsWith('/reactions?per_page=100')) return [];
      throw new Error(`unexpected paged request: ${path}`);
    },
    run(args) {
      runs.push(args);
    },
  };

  const result = reviewRepository(client, {
    owner: fixture.owner,
    entry: fixture.entry,
    actor: 'qwts',
    apply: false,
    requestReviews: true,
  });
  assert.equal(result.status, 'review-pending');
  assert.deepEqual(runs, []);
});

test('review-request mode ignores bot and read-only-human trigger lookalikes', () => {
  const fixture = approvalFixture();
  const runs = [];
  const comments = [
    {
      id: 98,
      created_at: '2026-07-25T10:01:00Z',
      user: { login: 'review-bot[bot]', type: 'Bot' },
      author_association: 'NONE',
      body: '@codex review',
    },
    {
      id: 99,
      created_at: '2026-07-25T10:02:00Z',
      user: { login: 'external-user', type: 'User' },
      author_association: 'MEMBER',
      body: '@codex review',
    },
  ];
  const client = {
    json(args) {
      if (args[1] === '/repos/qwts/target') return fixture.metadata;
      if (args[1] === '/repos/qwts/target/commits/head-sha') {
        return { commit: { committer: { date: '2026-07-25T10:00:00Z' } } };
      }
      if (args[1] === '/repos/qwts/target/collaborators/external-user/permission') {
        return { permission: 'read' };
      }
      return fixture.pull;
    },
    pages(path) {
      if (path.includes('pulls?state=open')) return [fixture.pull];
      if (path.endsWith('/files?per_page=100')) return fixture.files;
      if (path.includes('/issues/7/comments')) return comments;
      if (path.endsWith('/reviews?per_page=100')) return [];
      if (path.endsWith('/comments?per_page=100')) return [];
      if (path.endsWith('/reactions?per_page=100')) return [];
      throw new Error(`unexpected paged request: ${path}`);
    },
    run(args) {
      runs.push(args);
    },
  };

  const result = reviewRepository(client, {
    owner: fixture.owner,
    entry: fixture.entry,
    actor: 'qwts',
    apply: false,
    requestReviews: true,
  });
  assert.equal(result.status, 'review-requested');
  assert.equal(runs.length, 1);
});

test('apply approves and arms only a validated synchronization pull request', () => {
  const fixture = approvalFixture();
  const copilotReview = {
    id: 42,
    state: 'COMMENTED',
    commit_id: fixture.pull.head.sha,
    submitted_at: '2026-07-25T10:01:00Z',
    user: { login: COPILOT_REVIEW_BOT },
  };
  const runs = [];
  const client = {
    json(args) {
      const path = args[1];
      if (path === '/repos/qwts/target') return fixture.metadata;
      if (path === '/repos/qwts/target/pulls/7') return fixture.pull;
      if (path === '/repos/qwts/target/commits/head-sha') {
        return { commit: { committer: { date: '2026-07-25T10:00:00Z' } } };
      }
      throw new Error(`unexpected json request: ${args.join(' ')}`);
    },
    pages(path) {
      if (path.includes('pulls?state=open')) return [fixture.pull];
      if (path.endsWith('/files?per_page=100')) return fixture.files;
      if (path.endsWith('/reviews?per_page=100')) return [copilotReview];
      if (path.endsWith('/comments?per_page=100')) return [];
      if (path.endsWith('/reactions?per_page=100')) return [];
      throw new Error(`unexpected paged request: ${path}`);
    },
    run(args) {
      runs.push(args);
    },
  };

  const result = reviewRepository(client, {
    owner: fixture.owner,
    entry: fixture.entry,
    actor: 'qwts',
    apply: true,
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(runs.map((args) => args.slice(0, 2)), [
    ['pr', 'review'],
    ['pr', 'merge'],
  ]);
  assert.ok(runs[0].includes('--approve'));
  assert.ok(runs[1].includes('--auto'));
  assert.ok(runs[1].includes('--merge'));
});

test('an existing current approval and auto-merge request make apply idempotent', () => {
  const fixture = approvalFixture({
    auto_merge: { merge_method: 'merge' },
  });
  const copilotReview = {
    id: 42,
    state: 'COMMENTED',
    commit_id: fixture.pull.head.sha,
    submitted_at: '2026-07-25T10:01:00Z',
    user: { login: COPILOT_REVIEW_BOT },
  };
  const runs = [];
  const client = {
    json(args) {
      if (args[1] === '/repos/qwts/target') return fixture.metadata;
      if (args[1] === '/repos/qwts/target/commits/head-sha') {
        return { commit: { committer: { date: '2026-07-25T10:00:00Z' } } };
      }
      return fixture.pull;
    },
    pages(path) {
      if (path.includes('pulls?state=open')) return [fixture.pull];
      if (path.endsWith('/files?per_page=100')) return fixture.files;
      if (path.endsWith('/reviews?per_page=100')) {
        return [
          copilotReview,
          {
            user: { login: 'qwts' },
            state: 'APPROVED',
            commit_id: fixture.pull.head.sha,
          },
        ];
      }
      if (path.endsWith('/comments?per_page=100')) return [];
      if (path.endsWith('/reactions?per_page=100')) return [];
      throw new Error(`unexpected paged request: ${path}`);
    },
    run(args) {
      runs.push(args);
    },
  };

  reviewRepository(client, {
    owner: fixture.owner,
    entry: fixture.entry,
    actor: 'qwts',
    apply: true,
  });
  assert.deepEqual(runs, []);
});
