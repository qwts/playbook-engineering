import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectHarness } from '../detect-harness.mjs';

test('Claude Code is detected from CLAUDECODE', () => {
  assert.equal(detectHarness({ CLAUDECODE: '1' }), 'qwts-claude-agent');
});

test('Claude Code is detected from AI_AGENT/entrypoint markers too', () => {
  assert.equal(detectHarness({ AI_AGENT: 'claude-code_2_agent' }), 'qwts-claude-agent');
  assert.equal(detectHarness({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'qwts-claude-agent');
});

test('Codex is detected from a CODEX_ marker', () => {
  assert.equal(detectHarness({ CODEX_SANDBOX: 'seatbelt' }), 'qwts-codex-agent');
});

test('Cursor is detected and beats VS Code despite the shared vscode TERM_PROGRAM', () => {
  assert.equal(
    detectHarness({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.x.cursor' }),
    'qwts-cursor-agent',
  );
});

test('VS Code is detected from TERM_PROGRAM when no Cursor marker is present', () => {
  assert.equal(detectHarness({ TERM_PROGRAM: 'vscode' }), 'qwts-vscode-agent');
});

test('a bare shell resolves to no harness (stays human)', () => {
  assert.equal(detectHarness({ PATH: '/usr/bin', HOME: '/home/x' }), null);
});

test('a malformed env value never throws', () => {
  assert.doesNotThrow(() => detectHarness({ __CFBundleIdentifier: undefined, AI_AGENT: 123 }));
});
