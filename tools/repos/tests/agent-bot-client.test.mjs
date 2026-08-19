import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const env = {
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
  if (identity === 'configured') {
    for (const name of ['GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME']) {
      delete env[name];
    }
  }
  return spawnSync('sh', ['-c', managedPreCommand(adapter.path)], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env,
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

const GIT_IDENTITY_VARIABLES = [
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_NAME',
];

function configureIdentityRepository(cwd, name, email) {
  mkdirSync(cwd, { recursive: true });
  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.name', name],
    ['config', 'user.email', email],
    ['config', 'commit.gpgsign', 'false'],
  ]) {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }
  return cwd;
}

function realGitIdentity(cwd, executable, args) {
  const env = { ...process.env };
  for (const name of GIT_IDENTITY_VARIABLES) delete env[name];
  const run = spawnSync(executable, [...args, 'git', 'var', 'GIT_AUTHOR_IDENT'], {
    cwd,
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, `${executable} ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

function realGitChdirIdentity(cwd, args) {
  const env = { ...process.env };
  for (const name of GIT_IDENTITY_VARIABLES) delete env[name];
  const run = spawnSync('git', [...args, 'var', 'GIT_AUTHOR_IDENT'], {
    cwd,
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
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
    'printf x > "$(git commit -m x)"',
    'grep x <<< "$(git commit -m x)"',
    'printf x >',
    "print -r -- *(e:'git commit -m x':)",
    'printf "git commit -m x\\n" | sh',
    'if ! git commit -m x; then :; fi',
    'nohup git commit -m x',
    'nice git commit -m x',
    'PATH+=:/tmp git commit -m x',
    "sh <<'EOF'\ngit commit -m x\nEOF",
    'cat <<EOF\n$(git commit -m x)\nEOF',
    "cat <<'EOF'\nbody without terminator",
    "cat <<'EOF'\ninert\nEOF\ngit commit -m x",
    'git status \\',
    'git --exec-path=/tmp',
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
    'git am --continue',
    'git cherry-pick --continue',
    'git merge --continue',
    'git rebase --continue',
    'git rebase --skip',
    'git revert --continue',
    'git merge --abort topic',
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
    'git notes get-ref',
    'git notes list',
    'git notes show',
    'git notes show deadbeef',
    'git reset HEAD~1',
    'git reset --hard',
    'git am --abort',
    'git am --quit',
    'git cherry-pick --abort',
    'git cherry-pick --quit',
    'git merge --abort',
    'git merge --quit',
    'git rebase --abort',
    'git rebase --quit',
    'git revert --abort',
    'git revert --quit',
    'git -h',
    'git --help',
    'git -v',
    'git --version',
    'git --exec-path',
    'git --html-path',
    'git --info-path',
    'git --man-path',
    'git --no-pager --version',
    'gh pr view 1',
    'gh api --method GET repos/qwts/example',
    "echo 'git commit'",
    "printf '%s' 'git push'",
    "cat > file <<'EOF'\ngit commit -m inert text\nEOF",
    "python3 - <<'PY'\nprint('ok')\nPY",
    "cat <<-'EOF'\n\tbody\n\tEOF",
    "cat <<'EOF' # inert body follows\ntext\nEOF",
    `printf '%s' "$value" > "$file"`,
    `cat < "$file"`,
    `grep x <<< "$text"`,
    '( printf ok )',
  ];
  for (const adapter of managedAdapters) {
    for (const command of benign) adapterAllowed(adapter, command);
  }
});

test('Git identity lookup follows the operation global context in every adapter', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'uninstalled-identity-context-'));
  const unmanaged = join(scratch, 'unmanaged');
  const human = join(scratch, 'human');
  const configure = (repo, name, email) => {
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', name]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', email]);
  };
  configure(unmanaged, 'ai9d', 'ai9d@example.test');
  configure(human, 'Human User', 'human@example.test');
  try {
    for (const adapter of managedAdapters) {
      assert.equal(adapterDenied(
        adapter,
        `git -c user.name='Human User' -c user.email=human@example.test merge --no-ff topic`,
        'configured',
        { cwd: unmanaged },
      ), true, `${adapter.path} must honor human -c identity overrides`);
      adapterAllowed(
        adapter,
        `git -c user.name=ai9d -c user.email=ai9d@example.test merge --no-ff topic`,
        'configured',
        { cwd: human },
      );
      assert.equal(adapterDenied(
        adapter,
        `git -C '${human}' merge --no-ff topic`,
        'configured',
        { cwd: unmanaged },
      ), true, `${adapter.path} must resolve identity in Git's -C repository`);
      adapterAllowed(
        adapter,
        `git -C '${unmanaged}' merge --no-ff topic`,
        'configured',
        { cwd: human },
      );
      assert.equal(adapterDenied(
        adapter,
        `env -C '${human}' git merge --no-ff topic`,
        'configured',
        { cwd: unmanaged },
      ), true, `${adapter.path} must resolve identity in the wrapper cwd`);
      adapterAllowed(
        adapter,
        `NAME=ai9d EMAIL=ai9d@example.test git --config-env=user.name=NAME --config-env=user.email=EMAIL merge --no-ff topic`,
        'configured',
        { cwd: human },
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('env wrapper and Git chdir composition matches the real runtime in every adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'uninstalled-wrapper-cwd-'));
  const outside = join(root, 'outside');
  configureIdentityRepository(root, 'ai9d', 'ai9d@example.test');
  configureIdentityRepository(outside, 'Human User', 'human@example.test');
  try {
    assert.match(
      realGitIdentity(root, 'env', ['-C', 'outside', 'env', '-C', '.']),
      /^Human User </u,
      'a nested env resolves its relative chdir from the preceding wrapper cwd',
    );
    assert.match(
      realGitIdentity(root, 'env', ['-C', 'outside', '-C', '.']),
      /^ai9d </u,
      'one env applies only its final chdir from that wrapper entry cwd',
    );
    assert.match(
      realGitChdirIdentity(root, ['-C', 'outside', '-C', '.']),
      /^Human User </u,
      'Git composes each relative -C from the preceding Git cwd',
    );

    for (const adapter of managedAdapters) {
      assert.equal(adapterDenied(
        adapter,
        'env -C outside env -C . git merge --no-ff topic',
        'configured',
        { cwd: root },
      ), true, `${adapter.path} must compose nested env cwd hops`);
      adapterAllowed(
        adapter,
        'env -C outside -C . git merge --no-ff topic',
        'configured',
        { cwd: root },
      );
      assert.equal(adapterDenied(
        adapter,
        'git -C outside -C . merge --no-ff topic',
        'configured',
        { cwd: root },
      ), true, `${adapter.path} must retain Git's sequential -C semantics`);
    }

    execFileSync('git', ['config', 'user.name', 'Human User'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'human@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'ai9d'], { cwd: outside });
    execFileSync('git', ['config', 'user.email', 'ai9d@example.test'], { cwd: outside });

    assert.match(realGitIdentity(root, 'env', ['-C', 'outside', 'env', '-C', '.']), /^ai9d </u);
    assert.match(realGitIdentity(root, 'env', ['-C', 'outside', '-C', '.']), /^Human User </u);
    assert.match(realGitChdirIdentity(root, ['-C', 'outside', '-C', '.']), /^ai9d </u);
    for (const adapter of managedAdapters) {
      adapterAllowed(
        adapter,
        'env -C outside env -C . git merge --no-ff topic',
        'configured',
        { cwd: root },
      );
      assert.equal(adapterDenied(
        adapter,
        'env -C outside -C . git merge --no-ff topic',
        'configured',
        { cwd: root },
      ), true, `${adapter.path} must keep one env's final -C relative to its entry cwd`);
      adapterAllowed(
        adapter,
        'git -C outside -C . merge --no-ff topic',
        'configured',
        { cwd: root },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
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
