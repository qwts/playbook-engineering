import { test } from 'node:test';
import assert from 'node:assert/strict';

import { credentialHelperCommand } from '../setup-worktree.mjs';
import { helperSlug } from '../worktree-token.mjs';

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
