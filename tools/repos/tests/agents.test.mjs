import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { activeAgentSlugs, loadAgents, validateAgents } from '../lib/agents.mjs';
import { apps } from '../drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function roster(...agents) {
  return { account: 'qwts', agents };
}
const ok = { slug: 'qwts-claude-opus-agent', harness: 'claude-code', status: 'active' };

test('the checked-in roster is valid, and every entry has its App config shape', () => {
  const checkedIn = loadAgents(join(ROOT, 'governance', 'agents.json'));
  assert.deepEqual(validateAgents(checkedIn), []);
  assert.ok(checkedIn.agents.length > 0);
});

test('drift verifies exactly the active roster — no hardcoded list', () => {
  const checkedIn = loadAgents(join(ROOT, 'governance', 'agents.json'));
  assert.deepEqual(apps(ROOT), activeAgentSlugs(checkedIn));
  assert.ok(
    apps(ROOT).includes('qwts-claude-fable-agent'),
    'an agent added to the roster is checked without touching drift',
  );
});

test('a retired identity keeps its row but stops being checked', () => {
  const retired = roster(ok, { slug: 'qwts-old-agent', harness: 'claude-code', status: 'retired' });
  assert.deepEqual(validateAgents(retired), []);
  assert.deepEqual(activeAgentSlugs(retired), ['qwts-claude-opus-agent']);
});

test('malformed rosters fail rather than silently shrinking what is checked', () => {
  assert.deepEqual(validateAgents([]), ['agent roster must be a JSON object']);
  assert.match(validateAgents(roster({ ...ok, slug: '../escape' }))[0] ?? '', /must be a GitHub App slug/);
  assert.match(validateAgents(roster({ ...ok, slug: 'app;echo-owned' }))[0] ?? '', /must be a GitHub App slug/);
  assert.match(validateAgents(roster(ok, ok))[0] ?? '', /duplicates/);
  assert.match(validateAgents(roster({ ...ok, status: 'paused' }))[0] ?? '', /status must be one of/);
  assert.match(validateAgents(roster({ ...ok, harness: '' }))[0] ?? '', /harness must be a non-empty string/);
  assert.match(validateAgents(roster({ ...ok, typo: true }))[0] ?? '', /unknown field "typo"/);
  assert.match(validateAgents({ account: '', agents: [] })[0] ?? '', /account must be/);
  assert.match(validateAgents({ account: 'qwts' })[0] ?? '', /agents must be an array/);
  assert.match(validateAgents({ account: 'qwts', agents: [], extra: 1 })[0] ?? '', /roster has unknown field "extra"/);
});

test('every registered agent is documented in the identity runbook', () => {
  // The roster is machine-readable; the runbook is its human-readable view.
  // A slug that exists in one and not the other is how an agent ends up
  // operating that nobody knows to install.
  const runbook = readFileSync(join(ROOT, 'docs', 'reference', 'agent-bot-identity.md'), 'utf8');
  for (const agent of loadAgents(join(ROOT, 'governance', 'agents.json')).agents) {
    assert.ok(runbook.includes(agent.slug), `${agent.slug} is missing from the identity runbook`);
  }
});
