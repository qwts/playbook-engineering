import { test } from 'node:test';
import assert from 'node:assert/strict';

import { credentialHelperCommand, validateAppSlug } from '../setup-worktree.mjs';
import { helperSlug } from '../worktree-token.mjs';

test('accepts shell-safe GitHub App slugs', () => {
  assert.equal(validateAppSlug('qwts-codex-agent'), 'qwts-codex-agent');
  assert.equal(validateAppSlug('App2'), 'App2');
});

test('rejects app slugs that could escape paths or inject shell syntax', () => {
  for (const slug of ['', '-leading', 'trailing-', '../escape', 'two words', 'app;echo-owned', "app'quoted"]) {
    assert.throws(() => validateAppSlug(slug), /invalid GitHub App slug/);
  }
});

test('normalizes and quotes a Windows credential-helper path for Git Bash', () => {
  const command = credentialHelperCommand(
    String.raw`C:\Users\Agent User\Code\playbook-engineering\tools\agent-bot\git-credential-bot.mjs`,
    'qwts-codex-agent',
  );

  assert.equal(
    command,
    "!node 'C:/Users/Agent User/Code/playbook-engineering/tools/agent-bot/git-credential-bot.mjs' qwts-codex-agent",
  );
  assert.equal(helperSlug(command), 'qwts-codex-agent');
});

test('preserves Unix credential-helper paths, including spaces and apostrophes', () => {
  const command = credentialHelperCommand(
    "/Users/Agent O'Neil/Code/playbook-engineering/tools/agent-bot/git-credential-bot.mjs",
    'qwts-codex-agent',
  );

  assert.equal(
    command,
    "!node '/Users/Agent O'\"'\"'Neil/Code/playbook-engineering/tools/agent-bot/git-credential-bot.mjs' qwts-codex-agent",
  );
  assert.equal(helperSlug(command), 'qwts-codex-agent');
});
