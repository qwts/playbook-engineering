import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentBotBinary,
  mintAgentToken,
  parseMintGrant,
  runMintCommand,
} from '../lib/agent-bot-client.mjs';
import { installationRepositories } from '../drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
