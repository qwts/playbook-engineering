import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STARTUP = path.join(ROOT, '.codex', 'scripts', 'ensure-identity.sh');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-startup-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  const globalConfig = path.join(root, 'gitconfig');
  const app = 'qwts-codex-sol-agent';
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  for (const key of Object.keys(env)) {
    if (/^(CODEX|CLAUDE|AI_AGENT|QWTS_AGENT|GH_AGENT_APP)/.test(key)) delete env[key];
  }
  mkdirSync(path.join(home, '.config', app), { recursive: true });
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(path.join(home, '.local', 'share', 'agent-bot', 'hooks'), { recursive: true });
  writeFileSync(
    path.join(home, '.local', 'share', 'agent-bot', 'hooks', 'prepare-commit-msg'),
    '#!/bin/sh\nexit 0\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(home, '.local', 'bin', 'agent-bot'),
    `#!/bin/sh
[ "$1" = "setup-worktree" ] || exit 64
printf '%s\\n' "$*" >"$HOME/agent-bot-invocation"
git config extensions.worktreeConfig true
git config --worktree agentBot.app "$GH_AGENT_APP"
git config --worktree agentBot.agentId agent_00000000-0000-4000-8000-000000000001
git config --worktree user.name "$GH_AGENT_APP[bot]"
git config --worktree credential.helper "!agent-bot credential $GH_AGENT_APP"
git config --worktree core.hooksPath "$HOME/.local/share/agent-bot/hooks"
if [ -n "$CODEX_THREAD_ID" ]; then state='transcript bound'; else state='transcript pending'; fi
echo "worktree configured for $GH_AGENT_APP[bot] as agent_00000000-0000-4000-8000-000000000001 ($state)"
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(home, '.config', app, 'bot-uid'), '309211430\n');
  writeFileSync(globalConfig, '');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo, env });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, env });
  writeFileSync(path.join(repo, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, env });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repo, env });
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'topic', worktree], {
    cwd: repo,
    env,
  });
  return { app, env, worktree };
}

test('Codex startup repairs a worktree created before harness markers exist', () => {
  const { app, env, worktree } = fixture();
  assert.throws(
    () => execFileSync('git', ['config', '--get', 'agentBot.agentId'], { cwd: worktree, env }),
    /Command failed/,
  );

  const startupEnv = {
    ...env,
    CODEX_THREAD_ID: 'thread-sol-1',
    GH_AGENT_APP: app,
  };
  execFileSync('bash', [STARTUP], { cwd: worktree, env: startupEnv, encoding: 'utf8' });

  const firstId = execFileSync('git', ['config', '--get', 'agentBot.agentId'], {
    cwd: worktree,
    env,
    encoding: 'utf8',
  }).trim();
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'agentBot.app'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    }).trim(),
    app,
  );
  assert.equal(
    execFileSync('git', ['config', '--get', 'user.name'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    }).trim(),
    `${app}[bot]`,
  );
  const helpers = execFileSync('git', ['config', '--get-all', 'credential.helper'], {
    cwd: worktree,
    env,
    encoding: 'utf8',
  }).trim().split('\n');
  assert.equal(helpers.at(-1), `!agent-bot credential ${app}`);
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'core.hooksPath'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    }).trim(),
    path.join(env.HOME, '.local', 'share', 'agent-bot', 'hooks'),
  );
  assert.equal(
    execFileSync('cat', [path.join(env.HOME, 'agent-bot-invocation')], { encoding: 'utf8' }).trim(),
    'setup-worktree',
  );

  execFileSync('bash', [STARTUP], { cwd: worktree, env: startupEnv });
  assert.equal(
    execFileSync('git', ['config', '--get', 'agentBot.agentId'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    }).trim(),
    firstId,
    'repeating startup for the same transcript is idempotent',
  );
});

test('Codex startup accepts a transcript-pending identity before the task exists', () => {
  const { app, env, worktree } = fixture();
  const result = spawnSync('bash', [STARTUP], {
    cwd: worktree,
    env: { ...env, GH_AGENT_APP: app },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const id = execFileSync('git', ['config', '--worktree', '--get', 'agentBot.agentId'], {
    cwd: worktree,
    env,
    encoding: 'utf8',
  }).trim();
  assert.equal(id, 'agent_00000000-0000-4000-8000-000000000001');
  assert.match(result.stdout, /transcript pending/);
});

test('Codex startup cannot be satisfied by identity values outside worktree scope', () => {
  const { app, env, worktree } = fixture();
  const fakePlaybook = path.join(path.dirname(worktree), 'fake-playbook');
  const fakeHooks = path.join(fakePlaybook, 'tools', 'agent-bot', 'hooks');
  mkdirSync(fakeHooks, { recursive: true });
  writeFileSync(
    path.join(fakePlaybook, 'tools', 'agent-bot', 'setup-worktree.mjs'),
    'process.exit(0);\n',
  );
  writeFileSync(path.join(fakeHooks, 'prepare-commit-msg'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  execFileSync('git', ['config', '--global', 'qwts.agentId', 'agent_global-spoof'], { env });
  execFileSync('git', ['config', '--global', 'qwts.agentApp', app], { env });
  execFileSync('git', ['config', '--global', 'user.name', `${app}[bot]`], { env });
  execFileSync('git', ['config', '--global', 'credential.helper', `!node helper.mjs ${app}`], {
    env,
  });
  execFileSync('git', ['config', '--global', 'core.hooksPath', fakeHooks], { env });
  writeFileSync(path.join(env.HOME, '.local', 'bin', 'agent-bot'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });

  const result = spawnSync('bash', [STARTUP], {
    cwd: worktree,
    env: {
      ...env,
      CODEX_THREAD_ID: 'thread-sol-spoof',
      GH_AGENT_APP: app,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /setup completed without an agentBot\.agentId/);
});

test('Codex startup retains read-only compatibility with legacy worktree pins', () => {
  const { app, env, worktree } = fixture();
  writeFileSync(
    path.join(env.HOME, '.local', 'bin', 'agent-bot'),
    `#!/bin/sh
[ "$1" = "setup-worktree" ] || exit 64
git config extensions.worktreeConfig true
git config --worktree qwts.agentApp "$GH_AGENT_APP"
git config --worktree qwts.agentId agent_00000000-0000-4000-8000-000000000002
git config --worktree user.name "$GH_AGENT_APP[bot]"
git config --worktree credential.helper "!agent-bot credential $GH_AGENT_APP"
git config --worktree core.hooksPath "$HOME/.local/share/agent-bot/hooks"
`,
    { mode: 0o755 },
  );

  const result = spawnSync('bash', [STARTUP], {
    cwd: worktree,
    env: { ...env, GH_AGENT_APP: app },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${app}\\[bot\\].*agent_00000000`));
});
