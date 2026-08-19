import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentBotBinary,
  mintAgentToken,
  parseMintGrant,
  runMintCommand,
} from '../lib/agent-bot-client.mjs';
import { installationRepositories } from '../drift.mjs';
import { renderUninstalledIdentityCommand } from '../lib/uninstalled-identity-adapter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const managedAdapters = [
  { dialect: 'claude', path: '.claude/settings.json' },
  { dialect: 'codex', path: '.codex/hooks.json' },
  { dialect: 'cursor', path: '.cursor/hooks.json' },
];

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

function managedPreCommand(path) {
  const value = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
  const matches = strings(value).filter((candidate) => (
    candidate.includes('agent-bot agent-hook')
    && candidate.includes('--event pre-command')
  ));
  assert.equal(matches.length, 1, `${path} must have one managed pre-command adapter`);
  return matches[0];
}

function runUninstalledAdapter(adapter, command, identity = 'human', options = {}) {
  const author = identity === 'unmanaged' ? 'ai9d' : 'Human User';
  const login = identity === 'unmanaged' ? 'ai9d' : 'qwts';
  const runtimeEnv = {
    ...process.env,
    AGENT_BOT_HOOK_BIN: join(ROOT, '.missing-agent-hook'),
    AGENT_BOT_UNMANAGED_AUTHORS: 'ai9d',
    GH_USER: login,
    GIT_AUTHOR_EMAIL: `${login}@example.test`,
    GIT_AUTHOR_NAME: author,
    GIT_COMMITTER_EMAIL: `${login}@example.test`,
    GIT_COMMITTER_NAME: author,
    ...(options.env || {}),
  };
  for (const [name, value] of Object.entries(options.env || {})) {
    if (value === null) delete runtimeEnv[name];
  }
  return spawnSync('sh', ['-c', managedPreCommand(adapter.path)], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env: runtimeEnv,
    input: JSON.stringify({ command }),
    timeout: 5000,
  });
}

function adapterDenied(adapter, command, identity = 'human', options = {}) {
  const run = runUninstalledAdapter(adapter, command, identity, options);
  assert.equal(run.status, 0, `${adapter.path} failed for ${JSON.stringify(command)}: ${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  return adapter.dialect === 'cursor'
    ? payload.permission === 'deny'
    : payload.hookSpecificOutput?.permissionDecision === 'deny';
}

function adapterAllowed(adapter, command, identity = 'human', options = {}) {
  const run = runUninstalledAdapter(adapter, command, identity, options);
  assert.equal(run.status, 0, `${adapter.path} failed for ${JSON.stringify(command)}: ${run.stderr}`);
  if (adapter.dialect === 'cursor') assert.deepEqual(JSON.parse(run.stdout), {});
  else assert.equal(run.stdout, '');
}

const withoutGitIdentity = {
  GIT_AUTHOR_EMAIL: null,
  GIT_AUTHOR_NAME: null,
  GIT_COMMITTER_EMAIL: null,
  GIT_COMMITTER_NAME: null,
};

function identityRepository(name, email) {
  const cwd = mkdtempSync(join(tmpdir(), 'uninstalled-identity-'));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', name],
    ['config', 'user.email', email],
  ]) {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  }
  return cwd;
}

const grant = (token = 'secret-token') => JSON.stringify({
  schema_version: 1,
  token,
  expires_at: '2026-08-01T20:00:00Z',
  installation_id: 42,
});

test('the executable defaults to PATH and permits an explicit override', () => {
  assert.equal(agentBotBinary({}), 'agent-bot');
  assert.equal(agentBotBinary({ AGENT_BOT_BIN: '/fixture/agent-bot' }), '/fixture/agent-bot');
  assert.throws(() => agentBotBinary({ AGENT_BOT_BIN: '  ' }), /must name an executable/);
});

test('minting uses the stable JSON contract without a shell', () => {
  const calls = [];
  const result = mintAgentToken({
    slug: 'qwts-codex-agent',
    env: { AGENT_BOT_BIN: '/fixture/agent-bot' },
    runner: (binary, args, options) => {
      calls.push({ binary, args, options });
      return { status: 0, stdout: grant() };
    },
  });
  assert.equal(result.token, 'secret-token');
  assert.deepEqual(calls[0].args, ['mint-token', '--app', 'qwts-codex-agent', '--json']);
  assert.equal(calls[0].binary, '/fixture/agent-bot');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('minting fails closed without reflecting secret-bearing output', () => {
  const token = 'must-not-appear';
  assert.throws(
    () => runMintCommand({ runner: () => ({ status: 1, stdout: token, stderr: token }) }),
    (error) => !error.message.includes(token) && /exit status 1/.test(error.message),
  );
  assert.throws(
    () => runMintCommand({ runner: () => ({ error: { code: 'ENOENT' } }) }),
    /was not found/,
  );
});

test('grant parsing rejects malformed, missing, and incomplete data', () => {
  assert.throws(() => parseMintGrant('not-json'), /malformed JSON/);
  assert.throws(() => parseMintGrant('{"schema_version":1}'), /omitted the token/);
  assert.throws(
    () => parseMintGrant('{"schema_version":1,"token":"x"}'),
    /incomplete grant/,
  );
});

test('installation coverage paginates through an injected API seam', async () => {
  const pages = [];
  const names = await installationRepositories('qwts-codex-agent', {
    mintToken: ({ slug }) => {
      assert.equal(slug, 'qwts-codex-agent');
      return JSON.parse(grant());
    },
    apiCall: async (path, token) => {
      assert.equal(token, 'secret-token');
      pages.push(path);
      return pages.length === 1
        ? { repositories: Array.from({ length: 100 }, (_, index) => ({ name: `repo-${index}` })) }
        : { repositories: [{ name: 'last-repo' }] };
    },
  });
  assert.equal(names.size, 101);
  assert.deepEqual(pages, [
    '/installation/repositories?per_page=100&page=1',
    '/installation/repositories?per_page=100&page=2',
  ]);
});

test('governed integrations use the installed CLI and the playbook suite excludes runtime tests', () => {
  const obsoleteRuntime = ['tools', 'agent-bot'].join('/');
  const legacyHome = ['PLAYBOOK', 'HOME'].join('_');
  const codex = readFileSync(join(ROOT, '.codex', 'scripts', 'ensure-identity.sh'), 'utf8');
  const claude = readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'codex-sync.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  assert.match(codex, /AGENT_BOT_BIN:-agent-bot/);
  assert.match(codex, /"\$setup" setup-worktree/);
  // The environment spawns this script in a non-login shell, which reads only
  // .zshenv -- where the installer does not register ~/.local/bin. Without this
  // rung `command -v` finds nothing and the runtime reports as missing while
  // its symlink is present.
  assert.match(codex, /installed="\$HOME\/\.local\/bin\/agent-bot"/);
  assert.match(codex, /elif \[\[ -x "\$installed" \]\]; then\n\s+"\$installed" setup-worktree/);
  // An explicit AGENT_BOT_BIN stays authoritative: if it is set and unusable the
  // script fails rather than silently configuring through the default install,
  // which would attribute the worktree to a different bot than the one named.
  assert.match(codex, /elif \[\[ -n "\$\{AGENT_BOT_BIN:-\}" \]\]; then/);
  assert.ok(
    codex.indexOf('${AGENT_BOT_BIN:-}" ]]; then') < codex.indexOf('-x "$installed"'),
    'the override guard must precede the installed-location fallback',
  );
  assert.match(codex, /AGENT_BOT_HOME:-[\s\S]*setup-worktree\.mjs/);
  assert.match(codex, /node "\$AGENT_BOT_HOME\/setup-worktree\.mjs"/);
  assert.ok(!codex.includes('qwts.agent'));
  assert.ok(!codex.includes(legacyHome));
  assert.ok(!codex.includes(obsoleteRuntime));
  assert.match(claude, /AGENT_BOT_BIN:-agent-bot/);
  assert.match(claude, /claude-worktree-create/);
  assert.doesNotMatch(claude, /playbook-claude/);
  assert.ok(!claude.includes(obsoleteRuntime));
  assert.match(workflow, /tools\/repos\/lib\/agent-bot-client\.mjs/);
  assert.ok(!pkg.scripts.test.includes(obsoleteRuntime));
  assert.equal(pkg.scripts['agent:identity'], undefined);
});

test('managed adapters render one fail-closed uninstalled classifier', () => {
  for (const adapter of managedAdapters) {
    assert.equal(
      managedPreCommand(adapter.path),
      renderUninstalledIdentityCommand(adapter.dialect),
      `${adapter.path} must render the canonical fallback source`,
    );
  }
});

test('every managed adapter denies shell spelling and wrapper bypasses', () => {
  const bypasses = [
    'g\\it commit -m x',
    'git pu\\sh origin HEAD',
    '2>/tmp/agent-hook-test git commit -m x',
    '(git commit -m x)',
    '{ git push; }',
    'if true; then git commit -m x; fi',
    'env -i git push',
    'env -C /tmp git commit -m x',
    'env --chdir=/tmp git commit -m x',
    "bash -c 'git commit -m x'",
    'echo $(git commit -m x)',
    'echo "${UNSET:-$(git commit -m x)}"',
    'echo "${OUTER:-${INNER:-$(git commit -m x)}}"',
    'echo "$(( $(git commit -m x) ))"',
    'echo "$(( 1 + $(( $(git commit -m x) )) ))"',
    'printf "git commit -m x\\n" | sh',
    'if ! git commit -m x; then :; fi',
    'nohup git commit -m x',
    'nice git commit -m x',
    'PATH+=:/tmp git commit -m x',
    'git status \\',
    'gh pr create --title x --body y',
    'gh api -XDELETE repos/qwts/example/issues/1',
    'gh api --method DELETE repos/qwts/example/issues/1',
    "sh -c 'gh issue close 1'",
  ];
  for (const adapter of managedAdapters) {
    for (const command of bypasses) {
      assert.equal(adapterDenied(adapter, command), true, `${adapter.path} must deny ${command}`);
    }
  }
});

test('every managed adapter protects commit-producing Git operations', () => {
  const operations = [
    'git am patch.mbox',
    'git cherry-pick deadbeef',
    'git commit -m x',
    'git commit-tree deadbeef',
    'git fast-import',
    'git filter-branch -- --all',
    'git merge --no-ff topic',
    'git notes add -m x',
    'git pull --rebase',
    'git rebase main',
    'git revert deadbeef',
    'git stash',
    'git stash drop',
    'git stash pop',
    'git stash push',
  ];
  for (const adapter of managedAdapters) {
    for (const command of operations) {
      assert.equal(adapterDenied(adapter, command), true, `${adapter.path} must deny ${command}`);
    }
  }
});

test('unambiguous reads and edits remain allowed in every managed adapter', () => {
  const benign = [
    'printf ok',
    'git status',
    'git diff --stat',
    'git add README.md',
    'git stash list',
    'git stash show',
    'git stash show stash@{0}',
    'gh pr view 1',
    'gh api --method GET repos/qwts/example',
    "echo 'git commit'",
    "printf '%s' 'git push'",
  ];
  for (const adapter of managedAdapters) {
    for (const command of benign) adapterAllowed(adapter, command);
  }
});

test('the named unmanaged principal can still publish through every adapter', () => {
  const publish = [
    'git commit -m x',
    'git merge --no-ff topic',
    'git push origin HEAD',
    'gh pr create --title x --body y',
  ];
  for (const adapter of managedAdapters) {
    for (const command of publish) adapterAllowed(adapter, command, 'unmanaged');
  }
});

test('repository and command-scoped Git config resolve with Git precedence', () => {
  const unmanaged = identityRepository('ai9d', 'ai9d@example.test');
  const human = identityRepository('Human User', 'human@example.test');
  try {
    for (const adapter of managedAdapters) {
      adapterAllowed(adapter, 'git commit -m x', 'human', {
        cwd: unmanaged,
        env: withoutGitIdentity,
      });
      assert.equal(adapterDenied(adapter, 'git commit -m x', 'human', {
        cwd: human,
        env: withoutGitIdentity,
      }), true);
      adapterAllowed(adapter, `git -C ${unmanaged} commit -m x`, 'human', {
        cwd: human,
        env: withoutGitIdentity,
      });
      assert.equal(adapterDenied(adapter, `git -C ${human} commit -m x`, 'human', {
        cwd: unmanaged,
        env: withoutGitIdentity,
      }), true, `${adapter.path} must resolve identity after Git -C`);
      adapterAllowed(adapter, `env -C ${unmanaged} git commit -m x`, 'human', {
        cwd: human,
        env: withoutGitIdentity,
      });
      assert.equal(adapterDenied(adapter, `env --chdir=${human} git commit -m x`, 'human', {
        cwd: unmanaged,
        env: withoutGitIdentity,
      }), true, `${adapter.path} must resolve identity after env --chdir`);
      assert.equal(adapterDenied(
        adapter,
        'git -c user.name=Someone -c user.email=else@example.test commit --allow-empty -m x',
        'human',
        { cwd: unmanaged, env: withoutGitIdentity },
      ), true, `${adapter.path} must honor the #232 reproduction overrides`);
      adapterAllowed(
        adapter,
        'git -c user.name=ai9d -c user.email=ai9d@example.test commit -m x',
        'human',
        { cwd: human, env: withoutGitIdentity },
      );
      adapterAllowed(
        adapter,
        'git -c user.name=Someone -c user.email=else@example.test -c user.name=ai9d -c user.email=ai9d@example.test commit -m x',
        'human',
        { cwd: human, env: withoutGitIdentity },
      );
      assert.equal(adapterDenied(
        adapter,
        'git -c user.name=ai9d -c user.email=ai9d@example.test -c user.name=Someone -c user.email=else@example.test commit -m x',
        'human',
        { cwd: unmanaged, env: withoutGitIdentity },
      ), true);
      adapterAllowed(
        adapter,
        'git -c user.name ai9d -c user.email ai9d@example.test commit -m x',
        'human',
        { cwd: human, env: withoutGitIdentity },
      );
      adapterAllowed(
        adapter,
        'git -c user.name Someone -c user.email else@example.test -c user.name ai9d -c user.email ai9d@example.test commit -m x',
        'human',
        { cwd: human, env: withoutGitIdentity },
      );
      assert.equal(adapterDenied(
        adapter,
        'git -c user.name ai9d -c user.email ai9d@example.test -c user.name Someone -c user.email else@example.test commit -m x',
        'human',
        { cwd: unmanaged, env: withoutGitIdentity },
      ), true, `${adapter.path} must preserve final-value precedence for split -c`);
      adapterAllowed(
        adapter,
        'git -c user.name=Someone -c user.email else@example.test -c user.name ai9d -c user.email=ai9d@example.test commit -m x',
        'human',
        { cwd: human, env: withoutGitIdentity },
      );
      assert.equal(adapterDenied(adapter, 'git -c commit -m x', 'human', {
        cwd: unmanaged,
        env: withoutGitIdentity,
      }), true, `${adapter.path} must fail closed when -c has no configuration operand`);
      for (const malformed of [
        'git -c user.name',
        'git -c user.name ai9d',
        'git -c user.name commit -m x',
      ]) {
        assert.equal(adapterDenied(adapter, malformed, 'human', {
          cwd: unmanaged,
          env: withoutGitIdentity,
        }), true, `${adapter.path} must fail closed on malformed split config ${malformed}`);
      }
    }
  } finally {
    rmSync(unmanaged, { recursive: true, force: true });
    rmSync(human, { recursive: true, force: true });
  }
});

test('--config-env and command environments feed the inspected Git process', () => {
  const unmanaged = identityRepository('ai9d', 'ai9d@example.test');
  const human = identityRepository('Human User', 'human@example.test');
  const unmanagedConfigEnv = {
    ...withoutGitIdentity,
    CONFIG_EMAIL: 'ai9d@example.test',
    CONFIG_NAME: 'ai9d',
  };
  try {
    for (const adapter of managedAdapters) {
      adapterAllowed(
        adapter,
        'git --config-env=user.name=CONFIG_NAME --config-env=user.email=CONFIG_EMAIL commit -m x',
        'human',
        { cwd: human, env: unmanagedConfigEnv },
      );
      adapterAllowed(
        adapter,
        'git --config-env user.name=CONFIG_NAME --config-env user.email=CONFIG_EMAIL commit -m x',
        'human',
        { cwd: human, env: unmanagedConfigEnv },
      );
      assert.equal(adapterDenied(
        adapter,
        'git --config-env=user.name=MISSING_NAME --config-env=user.email=MISSING_EMAIL commit -m x',
        'human',
        { cwd: unmanaged, env: withoutGitIdentity },
      ), true, `${adapter.path} must deny missing --config-env values`);
      assert.equal(adapterDenied(
        adapter,
        'git --config-env=user.name commit -m x',
        'human',
        { cwd: unmanaged, env: withoutGitIdentity },
      ), true, `${adapter.path} must deny malformed --config-env`);
      adapterAllowed(
        adapter,
        'GIT_AUTHOR_NAME=ai9d GIT_AUTHOR_EMAIL=ai9d@example.test GIT_COMMITTER_NAME=ai9d GIT_COMMITTER_EMAIL=ai9d@example.test git commit -m x',
        'human',
        { cwd: human },
      );
      adapterAllowed(
        adapter,
        'env -i GIT_AUTHOR_NAME=ai9d GIT_AUTHOR_EMAIL=ai9d@example.test GIT_COMMITTER_NAME=ai9d GIT_COMMITTER_EMAIL=ai9d@example.test git commit -m x',
        'human',
        { cwd: human },
      );
      assert.equal(adapterDenied(adapter, 'git commit -m x', 'human', {
        cwd: unmanaged,
        env: {
          GIT_AUTHOR_EMAIL: 'human@example.test',
          GIT_AUTHOR_NAME: 'Human User',
          GIT_COMMITTER_EMAIL: 'ai9d@example.test',
          GIT_COMMITTER_NAME: 'ai9d',
        },
      }), true, `${adapter.path} must require the effective author and committer`);
      assert.equal(adapterDenied(adapter, 'git commit -m x', 'human', {
        cwd: unmanaged,
        env: {
          GIT_AUTHOR_EMAIL: 'ai9d@example.test',
          GIT_AUTHOR_NAME: 'ai9d',
          GIT_COMMITTER_EMAIL: 'human@example.test',
          GIT_COMMITTER_NAME: 'Human User',
        },
      }), true, `${adapter.path} must reject a non-allowlisted committer`);
      assert.equal(adapterDenied(adapter, 'git commit -m x', 'human', {
        cwd: unmanaged,
        env: {
          ...withoutGitIdentity,
          GIT_AUTHOR_NAME: 'Human User',
        },
      }), true, `${adapter.path} must not ignore a name-only author override`);
      assert.equal(adapterDenied(adapter, 'git commit -m x', 'human', {
        cwd: unmanaged,
        env: {
          ...withoutGitIdentity,
          GIT_COMMITTER_EMAIL: 'human@example.test',
        },
      }), true, `${adapter.path} must not ignore an email-only committer override`);
      adapterAllowed(
        adapter,
        'git -c user.name=Someone -c user.email=else@example.test commit -m x',
        'human',
        {
          cwd: human,
          env: {
            GIT_AUTHOR_EMAIL: 'ai9d@example.test',
            GIT_AUTHOR_NAME: 'ai9d',
            GIT_COMMITTER_EMAIL: 'ai9d@example.test',
            GIT_COMMITTER_NAME: 'ai9d',
          },
        },
      );
      assert.equal(adapterDenied(
        adapter,
        'env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL git commit -m x',
        'unmanaged',
        { cwd: human },
      ), true, `${adapter.path} must apply env unsets before resolving Git identity`);
    }
  } finally {
    rmSync(unmanaged, { recursive: true, force: true });
    rmSync(human, { recursive: true, force: true });
  }
});

test('--author overrides only the author and malformed identity options fail closed', () => {
  const unmanaged = identityRepository('ai9d', 'ai9d@example.test');
  const humanAuthor = {
    GIT_AUTHOR_EMAIL: 'human@example.test',
    GIT_AUTHOR_NAME: 'Human User',
    GIT_COMMITTER_EMAIL: 'ai9d@example.test',
    GIT_COMMITTER_NAME: 'ai9d',
  };
  try {
    for (const adapter of managedAdapters) {
      assert.equal(adapterDenied(
        adapter,
        "git commit --author='Human User <human@example.test>' -m x",
        'human',
        { cwd: unmanaged, env: withoutGitIdentity },
      ), true);
      adapterAllowed(
        adapter,
        "git commit --author='ai9d <ai9d@example.test>' -m x",
        'unmanaged',
        { cwd: unmanaged },
      );
      adapterAllowed(
        adapter,
        "git commit --author='Human User <human@example.test>' --author='ai9d <ai9d@example.test>' -m x",
        'unmanaged',
        { cwd: unmanaged },
      );
      assert.equal(adapterDenied(
        adapter,
        "git commit --author='ai9d <ai9d@example.test>' --author='Human User <human@example.test>' -m x",
        'unmanaged',
        { cwd: unmanaged },
      ), true, `${adapter.path} must use the final --author like Git`);
      assert.equal(adapterDenied(
        adapter,
        "git commit --author='ai9d <human@example.test>' -m x",
        'unmanaged',
        { cwd: unmanaged },
      ), true, `${adapter.path} must validate the full explicit author identity`);
      for (const decoy of [
        "git commit -m '--author=ai9d <ai9d@example.test>'",
        "git commit --message '--author=ai9d <ai9d@example.test>'",
        "git commit '--message=--author=ai9d <ai9d@example.test>'",
        "git commit '-m--author=ai9d <ai9d@example.test>'",
        "git commit -- '--author=ai9d <ai9d@example.test>'",
      ]) {
        assert.equal(adapterDenied(adapter, decoy, 'human', {
          cwd: unmanaged,
          env: humanAuthor,
        }), true, `${adapter.path} must not read an author option from ${decoy}`);
      }
      for (const decoy of [
        "git commit -m '--author=Human User <human@example.test>'",
        "git commit -- '--author=Human User <human@example.test>'",
      ]) {
        adapterAllowed(adapter, decoy, 'unmanaged', { cwd: unmanaged });
      }
      for (const malformed of [
        'git commit --author -m x',
        'git commit --author= -m x',
        'git commit --author=ai9d -m x',
        'git commit --amend -m x',
        'git commit -C deadbeef -m x',
      ]) {
        assert.equal(adapterDenied(adapter, malformed, 'unmanaged', {
          cwd: unmanaged,
        }), true, `${adapter.path} must deny unresolved identity in ${malformed}`);
      }
      adapterAllowed(adapter, 'git commit --amend --reset-author -m x', 'unmanaged', {
        cwd: unmanaged,
      });
    }
  } finally {
    rmSync(unmanaged, { recursive: true, force: true });
  }
});

test('every protected Git operation checks a determinable author and committer', () => {
  const unmanaged = identityRepository('ai9d', 'ai9d@example.test');
  const human = identityRepository('Human User', 'human@example.test');
  const deterministic = [
    'git commit -m x',
    'git commit-tree deadbeef',
    'git merge --no-ff topic',
    'git notes add -m x',
    'git revert deadbeef',
    'git stash push',
  ];
  const inputDerived = [
    'git am patch.mbox',
    'git cherry-pick deadbeef',
    'git fast-import',
    'git filter-branch -- --all',
    'git pull --rebase',
    'git rebase main',
  ];
  try {
    for (const adapter of managedAdapters) {
      for (const command of deterministic) {
        adapterAllowed(adapter, command, 'human', {
          cwd: unmanaged,
          env: withoutGitIdentity,
        });
        assert.equal(adapterDenied(adapter, command, 'human', {
          cwd: human,
          env: withoutGitIdentity,
        }), true, `${adapter.path} must deny ${command} under a human identity`);
      }
      for (const command of inputDerived) {
        assert.equal(adapterDenied(adapter, command, 'human', {
          cwd: unmanaged,
          env: withoutGitIdentity,
        }), true, `${adapter.path} must fail closed when ${command} supplies authors from its input`);
      }
    }
  } finally {
    rmSync(unmanaged, { recursive: true, force: true });
    rmSync(human, { recursive: true, force: true });
  }
});
