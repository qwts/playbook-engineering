import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  if (identity === 'configured') {
    for (const name of ['GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME']) {
      delete runtimeEnv[name];
    }
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
const GIT_IDENTITY_VARIABLES = Object.keys(withoutGitIdentity);

function configureIdentityRepository(cwd, name, email) {
  mkdirSync(cwd, { recursive: true });
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', name],
    ['config', 'user.email', email],
    ['config', 'commit.gpgsign', 'false'],
  ]) {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  }
  return cwd;
}

function identityRepository(name, email) {
  return configureIdentityRepository(
    mkdtempSync(join(tmpdir(), 'uninstalled-identity-')),
    name,
    email,
  );
}

function runGit(cwd, args, overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete env[name];
  }
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run;
}

function runEnvGitIdent(cwd, args) {
  const env = { ...process.env };
  for (const name of Object.keys(withoutGitIdentity)) delete env[name];
  const run = spawnSync('env', [...args, 'git', 'var', 'GIT_AUTHOR_IDENT'], {
    cwd,
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, `env ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

function headIdentity(cwd) {
  const run = runGit(cwd, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', 'HEAD']);
  const [authorName, authorEmail, committerName, committerEmail] = run.stdout.trimEnd().split('\0');
  return { authorEmail, authorName, committerEmail, committerName };
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

test('repository and command-scoped Git config resolve with Git precedence', () => {
  const unmanaged = identityRepository('ai9d', 'ai9d@example.test');
  const human = identityRepository('Human User', 'human@example.test');
  try {
    runGit(unmanaged, [
      '-c', 'advice.detachedHead', 'commit', '--allow-empty', '-m', 'valueless config',
    ], withoutGitIdentity);
    assert.deepEqual(headIdentity(unmanaged), {
      authorEmail: 'ai9d@example.test',
      authorName: 'ai9d',
      committerEmail: 'ai9d@example.test',
      committerName: 'ai9d',
    }, 'real Git consumes one valueless -c operand before commit');
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
        'git -c advice.detachedHead commit --allow-empty -m x',
        'human',
        { cwd: unmanaged, env: withoutGitIdentity },
      );
      assert.equal(adapterDenied(adapter, 'git -c commit -m x', 'human', {
        cwd: unmanaged,
        env: withoutGitIdentity,
      }), true, `${adapter.path} must fail closed when -c has no configuration operand`);
      for (const malformed of [
        'git -c user.name',
        'git -c user.name ai9d',
        'git -c user.name ai9d -c user.email ai9d@example.test commit -m x',
        'git -c user.name=Someone -c user.email else@example.test commit -m x',
      ]) {
        assert.equal(adapterDenied(adapter, malformed, 'human', {
          cwd: unmanaged,
          env: withoutGitIdentity,
        }), true, `${adapter.path} must fail closed when a second token is mistaken for a -c value: ${malformed}`);
      }
      assert.equal(adapterDenied(adapter, 'git -c user.name commit -m x', 'human', {
        cwd: unmanaged,
        env: withoutGitIdentity,
      }), true, `${adapter.path} must apply a valueless identity override before checking the commit`);
    }
  } finally {
    rmSync(unmanaged, { recursive: true, force: true });
    rmSync(human, { recursive: true, force: true });
  }
});

test('documented commit untracked-file options preserve determinable identity', () => {
  const unmanaged = identityRepository('ai9d', 'ai9d@example.test');
  const valid = [
    { args: ['-u'], shell: '-u' },
    { args: ['-uno'], shell: '-uno' },
    { args: ['-unormal'], shell: '-unormal' },
    { args: ['-uall'], shell: '-uall' },
    { args: ['--untracked-files'], shell: '--untracked-files' },
    { args: ['--untracked-files=no'], shell: '--untracked-files=no' },
    { args: ['--untracked-files=normal'], shell: '--untracked-files=normal' },
    { args: ['--untracked-files=all'], shell: '--untracked-files=all' },
    { args: ['--no-untracked-files'], shell: '--no-untracked-files' },
  ];
  try {
    for (const [index, option] of valid.entries()) {
      runGit(unmanaged, [
        'commit', '--allow-empty', ...option.args, '-m', `untracked option ${index}`,
      ], withoutGitIdentity);
      assert.deepEqual(headIdentity(unmanaged), {
        authorEmail: 'ai9d@example.test',
        authorName: 'ai9d',
        committerEmail: 'ai9d@example.test',
        committerName: 'ai9d',
      }, `real Git must retain bot identity for ${option.shell}`);
      for (const adapter of managedAdapters) {
        adapterAllowed(
          adapter,
          `git commit --allow-empty ${option.shell} -m x`,
          'human',
          { cwd: unmanaged, env: withoutGitIdentity },
        );
      }
    }
    for (const adapter of managedAdapters) {
      for (const malformed of [
        'git commit --allow-empty -ubogus -m x',
        'git commit --allow-empty --untracked-files=bogus -m x',
        'git commit --allow-empty --no-untracked-files=no -m x',
      ]) {
        assert.equal(adapterDenied(adapter, malformed, 'human', {
          cwd: unmanaged,
          env: withoutGitIdentity,
        }), true, `${adapter.path} must fail closed on invalid untracked-file mode`);
      }
    }
  } finally {
    rmSync(unmanaged, { recursive: true, force: true });
  }
});

test('tokens after bare untracked-file flags remain Git pathspecs', () => {
  const unmanaged = identityRepository('ai9d', 'ai9d@example.test');
  const human = identityRepository('Human User', 'human@example.test');
  const cases = [
    { args: ['-u', 'no'], pathspec: 'no', shell: '-u no' },
    {
      args: ['--untracked-files', 'normal'],
      pathspec: 'normal',
      shell: '--untracked-files normal',
    },
  ];
  try {
    for (const name of ['no', 'normal', 'other']) {
      writeFileSync(join(unmanaged, name), `${name}\n`);
    }
    runGit(unmanaged, ['add', 'no', 'normal', 'other']);

    for (const option of cases) {
      const real = runGit(unmanaged, [
        'commit', '--dry-run', '--short', ...option.args,
      ], withoutGitIdentity);
      assert.match(
        real.stdout,
        new RegExp(`^A  ${option.pathspec}$`, 'mu'),
        `real Git must treat ${option.shell} as a pathspec-bearing spelling`,
      );
      assert.doesNotMatch(
        real.stdout,
        /^A  other$/mu,
        `real Git must not consume ${option.pathspec} as an optional mode operand`,
      );
      for (const adapter of managedAdapters) {
        const command = `git commit --allow-empty ${option.shell} -m x`;
        adapterAllowed(adapter, command, 'human', {
          cwd: unmanaged,
          env: withoutGitIdentity,
        });
        assert.equal(adapterDenied(adapter, command, 'human', {
          cwd: human,
          env: withoutGitIdentity,
        }), true, `${adapter.path} must preserve identity checks for ${option.shell}`);
      }
    }
  } finally {
    rmSync(unmanaged, { recursive: true, force: true });
    rmSync(human, { recursive: true, force: true });
  }
});

test('nested env chdirs compose before Git identity inspection', () => {
  const root = mkdtempSync(join(tmpdir(), 'uninstalled-nested-env-cwd-'));
  const actual = configureIdentityRepository(join(root, 'a', 'b'), 'Human User', 'human@example.test');
  const decoy = configureIdentityRepository(join(root, 'b'), 'ai9d', 'ai9d@example.test');
  try {
    assert.match(runEnvGitIdent(root, ['-C', 'a', 'env', '-C', 'b']), /^Human User </u);
    assert.match(runEnvGitIdent(root, ['-C', 'a', '-C', 'b']), /^ai9d </u);
    for (const adapter of managedAdapters) {
      assert.equal(adapterDenied(
        adapter,
        'env -C a env --chdir=b git commit -m x',
        'human',
        { cwd: root, env: withoutGitIdentity },
      ), true, `${adapter.path} must inspect the cwd reached by both env wrappers`);
      adapterAllowed(
        adapter,
        'env -C a --chdir=b git commit -m x',
        'human',
        { cwd: root, env: withoutGitIdentity },
      );
    }

    runGit(actual, ['config', 'user.name', 'ai9d']);
    runGit(actual, ['config', 'user.email', 'ai9d@example.test']);
    runGit(decoy, ['config', 'user.name', 'Human User']);
    runGit(decoy, ['config', 'user.email', 'human@example.test']);
    assert.match(runEnvGitIdent(root, ['-C', 'a', 'env', '-C', 'b']), /^ai9d </u);
    assert.match(runEnvGitIdent(root, ['-C', 'a', '-C', 'b']), /^Human User </u);
    for (const adapter of managedAdapters) {
      adapterAllowed(
        adapter,
        'env --chdir=a env -Cb git commit -m x',
        'human',
        { cwd: root, env: withoutGitIdentity },
      );
      assert.equal(adapterDenied(
        adapter,
        'env --chdir=a -Cb git commit -m x',
        'human',
        { cwd: root, env: withoutGitIdentity },
      ), true, `${adapter.path} must apply only the final chdir of one env wrapper`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('negated commit identity options use Git last-option-wins semantics', () => {
  const authorRepo = identityRepository('Human User', 'human@example.test');
  const resetRepo = identityRepository('Human User', 'human@example.test');
  const botCommitter = {
    ...withoutGitIdentity,
    GIT_COMMITTER_EMAIL: 'ai9d@example.test',
    GIT_COMMITTER_NAME: 'ai9d',
  };
  const botIdentity = {
    GIT_AUTHOR_EMAIL: 'ai9d@example.test',
    GIT_AUTHOR_NAME: 'ai9d',
    GIT_COMMITTER_EMAIL: 'ai9d@example.test',
    GIT_COMMITTER_NAME: 'ai9d',
  };
  const cancelledAuthor = "git commit --allow-empty --author='ai9d <ai9d@example.test>' --no-author -m x";
  const restoredAuthor = "git commit --allow-empty --no-author --author='ai9d <ai9d@example.test>' -m x";
  const cancelledReset = 'git commit --allow-empty -C HEAD --reset-author --no-reset-author';
  const restoredReset = 'git commit --allow-empty -C HEAD --no-reset-author --reset-author';

  try {
    runGit(authorRepo, [
      'commit', '--allow-empty', '--author=ai9d <ai9d@example.test>', '--no-author', '-m', 'cancel author',
    ], botCommitter);
    assert.deepEqual(headIdentity(authorRepo), {
      authorEmail: 'human@example.test',
      authorName: 'Human User',
      committerEmail: 'ai9d@example.test',
      committerName: 'ai9d',
    }, 'real Git must cancel an earlier --author');
    for (const adapter of managedAdapters) {
      assert.equal(adapterDenied(adapter, cancelledAuthor, 'human', {
        cwd: authorRepo,
        env: botCommitter,
      }), true, `${adapter.path} must deny the real --author/--no-author identity`);
    }

    runGit(authorRepo, [
      'commit', '--allow-empty', '--no-author', '--author=ai9d <ai9d@example.test>', '-m', 'restore author',
    ], botCommitter);
    assert.deepEqual(headIdentity(authorRepo), {
      authorEmail: 'ai9d@example.test',
      authorName: 'ai9d',
      committerEmail: 'ai9d@example.test',
      committerName: 'ai9d',
    }, 'real Git must honor a final --author');
    for (const adapter of managedAdapters) {
      adapterAllowed(adapter, restoredAuthor, 'human', { cwd: authorRepo, env: botCommitter });
    }

    runGit(resetRepo, ['commit', '--allow-empty', '-m', 'human seed'], withoutGitIdentity);
    runGit(resetRepo, [
      'commit', '--allow-empty', '-C', 'HEAD', '--reset-author', '--no-reset-author',
    ], botIdentity);
    assert.deepEqual(headIdentity(resetRepo), {
      authorEmail: 'human@example.test',
      authorName: 'Human User',
      committerEmail: 'ai9d@example.test',
      committerName: 'ai9d',
    }, 'real Git must cancel an earlier --reset-author');
    for (const adapter of managedAdapters) {
      assert.equal(adapterDenied(adapter, cancelledReset, 'human', {
        cwd: resetRepo,
        env: botIdentity,
      }), true, `${adapter.path} must deny the real --reset-author/--no-reset-author identity`);
    }

    runGit(resetRepo, [
      'commit', '--allow-empty', '-C', 'HEAD', '--no-reset-author', '--reset-author',
    ], botIdentity);
    assert.deepEqual(headIdentity(resetRepo), {
      authorEmail: 'ai9d@example.test',
      authorName: 'ai9d',
      committerEmail: 'ai9d@example.test',
      committerName: 'ai9d',
    }, 'real Git must honor a final --reset-author');
    for (const adapter of managedAdapters) {
      adapterAllowed(adapter, restoredReset, 'human', { cwd: resetRepo, env: botIdentity });
    }
  } finally {
    rmSync(authorRepo, { recursive: true, force: true });
    rmSync(resetRepo, { recursive: true, force: true });
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
