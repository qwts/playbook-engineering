import { test } from 'node:test';
import assert from 'node:assert/strict';

import { worktreeSlug } from '../worktree-token.mjs';

test('extracts the slug baked into the credential-helper line', () => {
  const helpers = '\n!node /Users/x/Code/playbook-engineering/tools/agent-bot/git-credential-bot.mjs qwts-codex-agent';
  assert.equal(worktreeSlug(helpers, null), 'qwts-codex-agent');
});

test('a pinned identity outranks the helper line', () => {
  const helpers = '!node /x/git-credential-bot.mjs qwts-codex-agent';
  assert.equal(worktreeSlug(helpers, 'qwts-claude-agent'), 'qwts-claude-agent');
});

test('no helper means human context', () => {
  assert.equal(worktreeSlug('', null), null);
  assert.equal(worktreeSlug('osxkeychain\n!gh auth git-credential', null), null);
});

test('a pin without the helper marker never makes bot territory', () => {
  // A stray qwts.agentApp in a human clone must not cause a mint.
  assert.equal(worktreeSlug('', 'qwts-claude-agent'), null);
  assert.equal(worktreeSlug('osxkeychain', 'qwts-claude-agent'), null);
});

test('the last bot helper line wins when several exist', () => {
  const helpers = '!node /a/git-credential-bot.mjs old-slug\n!node /b/git-credential-bot.mjs new-slug';
  assert.equal(worktreeSlug(helpers, null), 'new-slug');
});
