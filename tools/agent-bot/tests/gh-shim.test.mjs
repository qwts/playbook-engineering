import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { buildGhShim } from '../gh-shim.mjs';

const root = mkdtempSync(join(tmpdir(), 'gh-shim-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function runShim({
  slug = '',
  agentSlug = '',
  agentEnv = {},
  token = '',
  tokenLogin = 'explicit-token-owner',
  args = ['whoami'],
  tokenToolAvailable = true,
} = {}) {
  const shimDir = join(root, `shim-${Math.random()}`);
  const realDir = join(root, `real-${Math.random()}`);
  mkdirSync(shimDir);
  mkdirSync(realDir);

  const tokenTool = join(root, `token-${Math.random()}.mjs`);
  if (tokenToolAvailable) {
    writeFileSync(
      tokenTool,
      `if (process.argv.includes('--slug')) process.stdout.write(${JSON.stringify(slug)});
if (process.argv.includes('--agent-slug')) process.stdout.write(${JSON.stringify(agentSlug)});`,
    );
  }

  const shim = join(shimDir, 'gh');
  writeFileSync(shim, buildGhShim(tokenTool));
  chmodSync(shim, 0o755);

  const real = join(realDir, 'gh');
  writeFileSync(
    real,
    `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo ${JSON.stringify(tokenLogin)}; exit 0; fi
if [ "$1 $2 $3 $4" = "api user --jq .login" ]; then echo human-owner; exit 0; fi
exit 64
`,
  );
  chmodSync(real, 0o755);

  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_')),
  );
  return spawnSync('sh', [shim, ...args], {
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      AI_AGENT: '',
      CLAUDECODE: '',
      CLAUDE_CODE_ENTRYPOINT: '',
      GH_TOKEN: token,
      PATH: [shimDir, realDir, process.env.PATH].filter(Boolean).join(delimiter),
      ...agentEnv,
    },
  });
}

function runWhoami(options = {}) {
  const result = runShim(options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('a matching explicit bot token is accepted in bot territory', () => {
  assert.equal(
    runWhoami({
      slug: 'qwts-codex-agent',
      token: 'explicit-token',
      tokenLogin: 'qwts-codex-agent[bot]',
    }),
    'qwts-codex-agent[bot] — explicit GH_TOKEN',
  );
});

test('an explicit human token is rejected in bot territory', () => {
  const result = runShim({
    slug: 'qwts-codex-agent',
    token: 'explicit-token',
    tokenLogin: 'human-owner',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected qwts-codex-agent\[bot\].*identity crossover/);
});

test('bot territory reports its local slug without an explicit token', () => {
  assert.equal(runWhoami({ slug: 'qwts-codex-agent' }), 'qwts-codex-agent[bot] — bot territory (ENG-0045)');
});

test('human territory asks stock gh for its login', () => {
  assert.equal(runWhoami(), 'human-owner — human territory, gh is stock');
});

test('an agent outside bot territory cannot query or write through stock gh', () => {
  for (const args of [['whoami'], ['issue', 'create', '--title', 'forbidden']]) {
    const result = runShim({
      agentSlug: 'qwts-codex-agent',
      args,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside bot territory.*refusing stock human gh/);
  }
});

test('a model-specific App marker is agent context and cannot use human gh outside bot territory', () => {
  const result = runShim({
    agentEnv: { GH_AGENT_APP: 'qwts-codex-sol-agent' },
    args: ['issue', 'create', '--title', 'forbidden'],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside bot territory.*refusing stock human gh/);
});

test('an agent fails closed when the installed token-helper path is stale', () => {
  const result = runShim({
    agentEnv: { CODEX_SANDBOX: 'seatbelt' },
    args: ['issue', 'create', '--title', 'forbidden'],
    tokenToolAvailable: false,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /token helper or Node is unavailable.*refusing stock human gh/);
  assert.match(result.stderr, /install-gh-shim/);
});

test('runtime playbook-home resolution finds the token helper without a baked path', () => {
  const home = mkdtempSync(join(tmpdir(), 'gh-shim-home-'));
  const playbook = join(home, 'playbook-engineering');
  const agentBot = join(playbook, 'tools', 'agent-bot');
  // Use .codex rather than .cursor — some sandboxes forbid creating .cursor paths.
  const worktree = join(home, '.codex', 'worktrees', 'repo');
  mkdirSync(agentBot, { recursive: true });
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(home, '.config', 'agent-bot', 'playbook-home'), `${playbook}\n`);
  writeFileSync(
    join(agentBot, 'worktree-token.mjs'),
    `if (process.argv.includes('--slug')) process.stdout.write('qwts-cursor-agent');
if (process.argv.includes('--agent-slug')) process.stdout.write('qwts-cursor-agent');`,
  );

  const shimDir = join(home, 'shim');
  const realDir = join(home, 'real');
  mkdirSync(shimDir);
  mkdirSync(realDir);
  const shim = join(shimDir, 'gh');
  writeFileSync(shim, buildGhShim());
  chmodSync(shim, 0o755);
  writeFileSync(
    join(realDir, 'gh'),
    `#!/bin/sh
if [ "$1" = "whoami" ] || [ "$1 $2 $3 $4" = "api user --jq .login" ]; then echo human; exit 0; fi
exit 0
`,
  );
  chmodSync(join(realDir, 'gh'), 0o755);

  const result = spawnSync('sh', [shim, 'whoami'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: [shimDir, realDir, process.env.PATH].filter(Boolean).join(delimiter),
      AI_AGENT: '',
      CLAUDECODE: '',
      CLAUDE_CODE_ENTRYPOINT: '',
      GH_TOKEN: '',
      PLAYBOOK_HOME: '',
    },
    cwd: worktree,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /qwts-cursor-agent\[bot\] — bot territory/);
});
