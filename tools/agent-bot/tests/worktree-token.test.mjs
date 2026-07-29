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
  assert.equal(pathSlug(`${HOME}/.codex/worktrees/5243/test-repo`), 'qwts-codex-agent');
  assert.equal(pathSlug(`${HOME}/.claude/worktrees/playbook-engineering/x`), 'qwts-claude-agent');
  assert.equal(pathSlug(`${HOME}/.cursor/worktrees/a/b`), 'qwts-cursor-agent');
  assert.equal(pathSlug(`${HOME}/.vscode/worktrees/a/b`), 'qwts-vscode-agent');
});

test('territory is the .<tool>/worktrees segment, at any root (ENG-0045 d1)', () => {
  // A boot volume too small for agent worktrees relocates them to an external
  // drive. That is a fact about the hardware; the work is still the bot's.
  // Anchoring the rule to $HOME demoted every worktree on such a machine to
  // human territory, where the shim refused to run and the agent fell back to
  // the human's credentials — the exact outcome ENG-0045 exists to prevent.
  assert.equal(pathSlug('/Volumes/added_storage/Code/.claude/worktrees/overlook/x'), 'qwts-claude-agent');
  assert.equal(pathSlug('/Volumes/big/.codex/worktrees/1/r'), 'qwts-codex-agent');
  assert.equal(pathSlug('/srv/agents/.vscode/worktrees/a/b'), 'qwts-vscode-agent');
});

test('paths outside .<tool>/worktrees are never territory', () => {
  const HOME = '/Users/u';
  assert.equal(pathSlug(`${HOME}/Code/test-repo`), null); // primary checkout
  assert.equal(pathSlug(`${HOME}/.config/agent-bot`), null); // dotdir, not worktrees
  assert.equal(pathSlug(`${HOME}/.unknowntool/worktrees/x/r`), null); // no matching App
  assert.equal(pathSlug('/tmp/worktrees/x'), null); // no dot-tool segment
  assert.equal(pathSlug('/Volumes/d/claude/worktrees/x/r'), null); // undotted, not a tool dir
  assert.equal(pathSlug('/Volumes/d/.claude/worktrees'), null); // the container, not a worktree
  assert.equal(pathSlug(null), null);
});

test('resolution order: pin picks WHICH bot, only inside territory', () => {
  const HOME = '/Users/u';
  const inTerritory = { toplevel: `${HOME}/.codex/worktrees/1/r`, helperLines: '' };
  assert.equal(resolveSlug({ ...inTerritory, pinned: null }), 'qwts-codex-agent');
  assert.equal(resolveSlug({ ...inTerritory, pinned: 'qwts-claude-agent' }), 'qwts-claude-agent');
  // pin + no territory signal = human, still
  assert.equal(resolveSlug({ pinned: 'qwts-claude-agent', toplevel: `${HOME}/Code/r`, helperLines: '' }), null);
  // helper line still marks configured worktrees outside the path pattern
  assert.equal(
    resolveSlug({ pinned: null, toplevel: `${HOME}/somewhere/r`, helperLines: '!node /x/git-credential-bot.mjs qwts-vscode-agent' }),
    'qwts-vscode-agent',
  );
});

test('the last bot helper line wins when several exist', () => {
  const helpers = '!node /a/git-credential-bot.mjs old-slug\n!node /b/git-credential-bot.mjs new-slug';
  assert.equal(worktreeSlug(helpers, null), 'new-slug');
});
