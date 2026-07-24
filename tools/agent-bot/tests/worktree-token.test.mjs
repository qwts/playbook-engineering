import { test } from 'node:test';
import assert from 'node:assert/strict';

import { worktreeSlug, pathSlug, resolveSlug } from '../worktree-token.mjs';

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

test('the directory dictates the App even with no config at all (ENG-0045 d1)', () => {
  // Sandboxed harnesses may never manage to write the worktree config —
  // the path alone must resolve the bot.
  const HOME = '/Users/u';
  assert.equal(pathSlug(`${HOME}/.codex/worktrees/5243/test-repo`, HOME), 'qwts-codex-agent');
  assert.equal(pathSlug(`${HOME}/.claude/worktrees/playbook-engineering/x`, HOME), 'qwts-claude-agent');
  assert.equal(pathSlug(`${HOME}/.cursor/worktrees/a/b`, HOME), 'qwts-cursor-agent');
  assert.equal(pathSlug(`${HOME}/.vscode/worktrees/a/b`, HOME), 'qwts-vscode-agent');
});

test('paths outside ~/.<tool>/worktrees are never territory', () => {
  const HOME = '/Users/u';
  assert.equal(pathSlug(`${HOME}/Code/test-repo`, HOME), null); // primary checkout
  assert.equal(pathSlug(`${HOME}/.config/agent-bot`, HOME), null); // dotdir, not worktrees
  assert.equal(pathSlug(`${HOME}/.unknowntool/worktrees/x/r`, HOME), null); // no matching App
  assert.equal(pathSlug('/tmp/worktrees/x', HOME), null);
  assert.equal(pathSlug(null, HOME), null);
});

test('resolution order: pin picks WHICH bot, only inside territory', () => {
  const HOME = '/Users/u';
  const inTerritory = { toplevel: `${HOME}/.codex/worktrees/1/r`, home: HOME, helperLines: '' };
  assert.equal(resolveSlug({ ...inTerritory, pinned: null }), 'qwts-codex-agent');
  assert.equal(resolveSlug({ ...inTerritory, pinned: 'qwts-claude-agent' }), 'qwts-claude-agent');
  // pin + no territory signal = human, still
  assert.equal(resolveSlug({ pinned: 'qwts-claude-agent', toplevel: `${HOME}/Code/r`, home: HOME, helperLines: '' }), null);
  // helper line still marks configured worktrees outside the path pattern
  assert.equal(
    resolveSlug({ pinned: null, toplevel: `${HOME}/somewhere/r`, home: HOME, helperLines: '!node /x/git-credential-bot.mjs qwts-vscode-agent' }),
    'qwts-vscode-agent',
  );
});

test('the last bot helper line wins when several exist', () => {
  const helpers = '!node /a/git-credential-bot.mjs old-slug\n!node /b/git-credential-bot.mjs new-slug';
  assert.equal(worktreeSlug(helpers, null), 'new-slug');
});
