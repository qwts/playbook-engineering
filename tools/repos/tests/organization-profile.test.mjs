import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAgents } from '../lib/agents.mjs';
import {
  ORGANIZATION_ID,
  defaultSlugFor,
  profileFromAgentsPath,
  projectOrganizationProfile,
  renderOrganizationProfile,
} from '../lib/organization-profile.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(ROOT, 'tools', 'repos', 'organization-profile.mjs');

function roster(...agents) {
  return { account: 'qwts', agents };
}

const claudeDefault = {
  slug: 'qwts-claude-agent',
  harness: 'claude-code',
  status: 'active',
};
const claudeModel = {
  slug: 'qwts-claude-opus-agent',
  harness: 'claude-code',
  status: 'active',
};

test('the checked-in profile is the projection of the roster', () => {
  const expected = profileFromAgentsPath(path.join(ROOT, 'governance', 'agents.json'));
  const actual = JSON.parse(readFileSync(path.join(ROOT, 'governance', 'organization-profile.json'), 'utf8'));
  assert.equal(renderOrganizationProfile(actual), renderOrganizationProfile(expected));
});

test('every roster slug appears, notes are stripped, and claude-code becomes claude', () => {
  const agents = loadAgents(path.join(ROOT, 'governance', 'agents.json'));
  const profile = projectOrganizationProfile(agents);
  assert.equal(profile.schema_version, 1);
  assert.equal(profile.organization, ORGANIZATION_ID);
  assert.equal(profile.account_owner, 'qwts');
  assert.equal(profile.minimum_runtime_interface_version, 1);
  assert.deepEqual(
    profile.identities.map((identity) => identity.slug).sort(),
    agents.agents.map((agent) => agent.slug).sort(),
  );
  assert.ok(profile.identities.every((identity) => identity.note === undefined));
  assert.ok(profile.identities.filter((identity) => identity.slug.startsWith('qwts-claude-')).every((identity) => identity.harness === 'claude'));
  assert.equal(profile.defaults.claude, 'qwts-claude-agent');
  assert.equal(profile.defaults.codex, 'qwts-codex-agent');
  assert.equal(profile.defaults.cursor, 'qwts-cursor-agent');
});

test('the default App is account-harness-agent and must be an active matching identity', () => {
  assert.equal(defaultSlugFor('qwts', 'claude'), 'qwts-claude-agent');
  const profile = projectOrganizationProfile(roster(claudeDefault, claudeModel));
  assert.deepEqual(profile.defaults, { claude: 'qwts-claude-agent' });
  assert.throws(
    () => projectOrganizationProfile(roster(claudeModel)),
    /qwts-claude-agent/,
  );
});

test('retired identities stay in the profile and do not become defaults', () => {
  const profile = projectOrganizationProfile(roster(
    claudeDefault,
    { slug: 'qwts-old-agent', harness: 'claude-code', status: 'retired' },
  ));
  assert.deepEqual(profile.defaults, { claude: 'qwts-claude-agent' });
  assert.ok(profile.identities.some((identity) => identity.slug === 'qwts-old-agent' && identity.status === 'retired'));
});

test('unknown roster harnesses and empty rosters fail closed', () => {
  assert.throws(
    () => projectOrganizationProfile(roster({ slug: 'qwts-windsurf-agent', harness: 'windsurf', status: 'active' })),
    /no runtime harness/,
  );
  assert.throws(
    () => projectOrganizationProfile(roster()),
    /at least one roster identity/,
  );
});

function scaffold(agents) {
  const root = mkdtempSync(path.join(tmpdir(), 'org-profile-'));
  mkdirSync(path.join(root, 'governance'), { recursive: true });
  writeFileSync(path.join(root, 'governance', 'agents.json'), JSON.stringify({ account: 'qwts', agents }, null, 2));
  return root;
}

function runCli(root, args = []) {
  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });
  } catch (error) {
    exitCode = error.status;
    output = `${error.stdout}${error.stderr}`;
  }
  return { exitCode, output };
}

test('check fails until --write, then matches the roster', () => {
  const root = scaffold([claudeDefault]);
  const missing = runCli(root, ['check']);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.output, /organization profile not found/);

  const written = runCli(root, ['--write']);
  assert.equal(written.exitCode, 0);

  const fresh = runCli(root, ['check']);
  assert.equal(fresh.exitCode, 0);
  const published = JSON.parse(readFileSync(path.join(root, 'governance', 'organization-profile.json'), 'utf8'));
  assert.equal(published.defaults.claude, 'qwts-claude-agent');

  writeFileSync(path.join(root, 'governance', 'organization-profile.json'), '{}\n');
  const stale = runCli(root, ['check']);
  assert.equal(stale.exitCode, 1);
  assert.match(stale.output, /out of date/);
  rmSync(root, { recursive: true, force: true });
});
