import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAgentIdentity } from '../agent-identity.mjs';
import { helperSlug } from '../worktree-token.mjs';

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
  const stateDir = path.join(root, 'state');
  const globalConfig = path.join(root, 'gitconfig');
  const app = 'qwts-codex-sol-agent';
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    PLAYBOOK_HOME: ROOT,
    QWTS_AGENT_STATE_HOME: stateDir,
  };
  for (const key of Object.keys(env)) {
    if (/^(CODEX|CLAUDE|AI_AGENT|QWTS_AGENT|GH_AGENT_APP)/.test(key)) delete env[key];
  }
  env.QWTS_AGENT_STATE_HOME = stateDir;

  mkdirSync(path.join(home, '.config', app), { recursive: true });
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
  return { app, env, stateDir, worktree };
}

test('Codex startup repairs a worktree created before harness markers exist', () => {
  const { app, env, stateDir, worktree } = fixture();
  assert.throws(
    () => execFileSync('git', ['config', '--get', 'qwts.agentId'], { cwd: worktree, env }),
    /Command failed/,
  );

  const startupEnv = {
    ...env,
    CODEX_THREAD_ID: 'thread-sol-1',
    GH_AGENT_APP: app,
  };
  execFileSync('bash', [STARTUP], { cwd: worktree, env: startupEnv, encoding: 'utf8' });

  const firstId = execFileSync('git', ['config', '--get', 'qwts.agentId'], {
    cwd: worktree,
    env,
    encoding: 'utf8',
  }).trim();
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'qwts.agentApp'], {
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
  assert.equal(helperSlug(helpers.at(-1)), app);
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'core.hooksPath'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    }).trim(),
    path.join(ROOT, 'tools', 'agent-bot', 'hooks'),
  );
  const record = readAgentIdentity(firstId, { stateDir });
  assert.equal(record.github.appSlug, app);
  assert.deepEqual(record.transcript, {
    provider: 'codex',
    id: 'thread-sol-1',
    sha256: null,
  });

  execFileSync('bash', [STARTUP], { cwd: worktree, env: startupEnv });
  assert.equal(
    execFileSync('git', ['config', '--get', 'qwts.agentId'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    }).trim(),
    firstId,
    'repeating startup for the same transcript is idempotent',
  );
});

test('Codex startup fails visibly rather than minting a transcript-pending identity', () => {
  const { app, env, worktree } = fixture();
  const result = spawnSync('bash', [STARTUP], {
    cwd: worktree,
    env: { ...env, GH_AGENT_APP: app },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no Codex transcript locator is available/);
  assert.throws(
    () => execFileSync('git', ['config', '--get', 'qwts.agentId'], { cwd: worktree, env }),
    /Command failed/,
  );
});
