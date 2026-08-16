import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateManifest,
  renderTable,
  renderBlock,
  extractBlock,
  spliceBlock,
  BEGIN_MARKER,
  END_MARKER,
} from '../lib/manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'repos.mjs');

function validManifest() {
  return {
    account: 'qwts',
    repos: [
      { name: 'playbook-engineering', visibility: 'public', status: 'active', sharedCi: true, delta: '', note: '' },
      { name: 'photos', visibility: 'public', status: 'onboarding', sharedCi: false, delta: 'A delta.', note: '' },
    ],
  };
}

// --- validation ---------------------------------------------------------

test('a well-formed manifest validates clean', () => {
  assert.deepEqual(validateManifest(validManifest()), []);
});

test('rejects an unknown visibility', () => {
  const m = validManifest();
  m.repos[0].visibility = 'internal';
  const errors = validateManifest(m);
  assert.ok(errors.some((e) => e.includes('visibility')));
});

test('rejects an unknown status', () => {
  const m = validManifest();
  m.repos[0].status = 'archived';
  assert.ok(validateManifest(m).some((e) => e.includes('status')));
});

test('rejects a duplicate repo name (case-insensitive)', () => {
  const m = validManifest();
  m.repos[1].name = 'Playbook-Engineering';
  assert.ok(validateManifest(m).some((e) => e.includes('duplicate')));
});

test('rejects a non-boolean sharedCi', () => {
  const m = validManifest();
  m.repos[0].sharedCi = 'yes';
  assert.ok(validateManifest(m).some((e) => e.includes('sharedCi')));
});

test('rejects a non-boolean publish', () => {
  // The dashboard opts in on `=== true`, so "true" and 1 withhold the repo.
  // Caught here rather than surfacing as a repo silently missing from a public
  // page, where nobody is looking for an absence.
  for (const value of ['true', 1, null, {}]) {
    const m = validManifest();
    m.repos[0].publish = value;
    assert.ok(
      validateManifest(m).some((e) => e.includes('publish')),
      `publish: ${JSON.stringify(value)} should be rejected`,
    );
  }
});

test('publish is optional, and absent means unpublished rather than invalid', () => {
  const m = validManifest();
  assert.equal(m.repos[0].publish, undefined);
  assert.deepEqual(validateManifest(m), []);

  const opted = validManifest();
  opted.repos[0].publish = true;
  assert.deepEqual(validateManifest(opted), []);
});

test('rejects a missing name', () => {
  const m = validManifest();
  delete m.repos[0].name;
  assert.ok(validateManifest(m).some((e) => e.includes('name')));
});

test('rejects a name that is not a repo slug (whitespace, slashes)', () => {
  for (const bad of ['photos ', 'my repo', 'qwts/photos']) {
    const m = validManifest();
    m.repos[0].name = bad;
    assert.ok(validateManifest(m).some((e) => e.includes('slug')), `should reject ${JSON.stringify(bad)}`);
  }
});

test('rejects repos that is not an array', () => {
  assert.ok(validateManifest({ account: 'qwts', repos: {} }).some((e) => e.includes('array')));
});

test('accepts explicit managed Codex exclusions', () => {
  const m = validManifest();
  m.repos[1].codexSync = {
    enabled: true,
    exclude: ['.codex/config.toml'],
  };
  assert.deepEqual(validateManifest(m), []);
});

test('rejects invalid managed Codex exclusions', () => {
  const m = validManifest();
  m.repos[1].codexSync = {
    enabled: 'yes',
    exclude: ['README.md', '.codex/config.toml', '.codex/config.toml'],
  };
  const errors = validateManifest(m);
  assert.ok(errors.some((error) => error.includes('enabled')));
  assert.ok(errors.some((error) => error.includes('unmanaged path')));
  assert.ok(errors.some((error) => error.includes('duplicate path')));
});

test('accepts explicit downstream JSON array-entry ownership', () => {
  const m = validManifest();
  m.repos[1].codexSync = {
    preserveJsonArrayEntries: {
      '.codex/hooks.json': ['agent-bot agent-hook'],
    },
  };
  assert.deepEqual(validateManifest(m), []);
});

test('rejects invalid downstream JSON array-entry ownership', () => {
  const m = validManifest();
  m.repos[1].codexSync = {
    exclude: ['.cursor/hooks.json'],
    preserveJsonArrayEntries: {
      'README.md': ['marker'],
      'governance/agent-models.json': ['marker'],
      '.codex/hooks.json': ['marker', 'marker', ''],
      '.cursor/hooks.json': ['marker'],
      '.claude/settings.json': [],
    },
  };
  const errors = validateManifest(m);
  assert.ok(errors.some((error) => error.includes('unmanaged JSON path')));
  assert.ok(errors.some((error) => error.includes('non-hook-adapter JSON path')));
  assert.ok(errors.some((error) => error.includes('duplicate marker')));
  assert.ok(errors.some((error) => error.includes('invalid marker')));
  assert.ok(errors.some((error) => error.includes('configures excluded path')));
  assert.ok(errors.some((error) => error.includes('must be a non-empty array')));
});

test('invalid exclusions do not crash composition validation', () => {
  const m = validManifest();
  m.repos[1].codexSync = {
    exclude: {},
    preserveJsonArrayEntries: {
      '.codex/hooks.json': ['agent-bot agent-hook'],
    },
  };

  assert.doesNotThrow(() => validateManifest(m));
  assert.ok(validateManifest(m).some((error) => error.includes('exclude must be an array')));
});

// --- rendering ----------------------------------------------------------

test('renderTable is deterministic for identical input', () => {
  assert.equal(renderTable(validManifest()), renderTable(validManifest()));
});

test('renderTable escapes pipes in a delta', () => {
  const m = validManifest();
  m.repos[1].delta = 'a | b';
  assert.ok(renderTable(m).includes('a \\| b'));
});

test('renderTable escapes backslashes before pipes, so \\| cannot smuggle a raw pipe', () => {
  const m = validManifest();
  m.repos[1].delta = 'a \\| b';
  // Backslash doubles first, then the pipe is escaped: `a \\\| b`.
  assert.ok(renderTable(m).includes('a \\\\\\| b'));
});

test('renderTable shows an em dash for an empty delta', () => {
  // playbook-engineering has an empty delta in the fixture -> em dash cell.
  assert.match(renderTable(validManifest()), /playbook-engineering.*\| — \|/);
});

test('renderTable shows managed Codex exceptions', () => {
  const m = validManifest();
  m.repos[1].codexSync = { exclude: ['.codex/config.toml'] };
  assert.match(renderTable(m), /managed except `\.codex\/config\.toml`/);
});

test('extractBlock round-trips what renderBlock writes', () => {
  const doc = `# Doc\n\n${BEGIN_MARKER}\n${END_MARKER}\n`;
  const spliced = spliceBlock(doc, validManifest());
  assert.equal(extractBlock(spliced), renderBlock(validManifest()));
});

test('spliceBlock throws when the markers are absent', () => {
  assert.throws(() => spliceBlock('# Doc with no markers\n', validManifest()), /markers not found/);
});

// --- CLI ----------------------------------------------------------------

function scaffold(manifest, roster = { account: 'qwts', agents: [] }) {
  const root = mkdtempSync(path.join(tmpdir(), 'repos-'));
  mkdirSync(path.join(root, 'governance'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'reference'), { recursive: true });
  writeFileSync(path.join(root, 'governance', 'repos.json'), JSON.stringify(manifest, null, 2));
  // The check gates the agent roster as well as the manifest (ENG-0079), so a
  // scaffolded root carries one.
  writeFileSync(path.join(root, 'governance', 'agents.json'), JSON.stringify(roster, null, 2));
  writeFileSync(
    path.join(root, 'docs', 'reference', 'governed-repos.md'),
    `# Governed repositories\n\n${BEGIN_MARKER}\n${END_MARKER}\n`,
  );
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

test('check fails on a stale doc, and --write then makes it pass', () => {
  const root = scaffold(validManifest());

  const stale = runCli(root, ['check']);
  assert.equal(stale.exitCode, 1);
  assert.match(stale.output, /out of date|missing the generated-table markers/);

  const written = runCli(root, ['--write']);
  assert.equal(written.exitCode, 0);

  const fresh = runCli(root, ['check']);
  assert.equal(fresh.exitCode, 0);
  assert.match(fresh.output, /in sync/);

  const doc = readFileSync(path.join(root, 'docs', 'reference', 'governed-repos.md'), 'utf8');
  assert.ok(doc.includes('| `photos` |'));
});

test('relative --manifest/--doc resolve against --root, not the cwd', () => {
  // The test process cwd differs from the scaffold root; relative paths must
  // still land inside the root, matching docs-gov's --config behavior.
  const root = scaffold(validManifest());
  const written = runCli(root, [
    '--write',
    '--manifest', path.join('governance', 'repos.json'),
    '--doc', path.join('docs', 'reference', 'governed-repos.md'),
  ]);
  assert.equal(written.exitCode, 0);
  const check = runCli(root, [
    'check',
    '--manifest', path.join('governance', 'repos.json'),
    '--doc', path.join('docs', 'reference', 'governed-repos.md'),
  ]);
  assert.equal(check.exitCode, 0);
  assert.match(check.output, /in sync/);
});

test('check fails when the agent roster is missing or malformed', () => {
  const root = scaffold({ account: 'qwts', repos: [] });
  writeFileSync(path.join(root, 'governance', 'agents.json'), JSON.stringify({ account: 'qwts', agents: [{}] }));
  const malformed = runCli(root);
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.output, /agents\[0\]\.slug must be a GitHub App slug/);

  rmSync(path.join(root, 'governance', 'agents.json'));
  const missing = runCli(root);
  assert.equal(missing.exitCode, 1, 'a roster that vanished must fail the gate, not shrink what drift checks');
  assert.match(missing.output, /agent roster not found/);
});

test('check fails when a non-empty roster has no matching organization profile', () => {
  const root = scaffold(validManifest(), {
    account: 'qwts',
    agents: [{ slug: 'qwts-claude-agent', harness: 'claude-code', status: 'active' }],
  });
  const missing = runCli(root, ['--write']);
  assert.equal(missing.exitCode, 0);
  rmSync(path.join(root, 'governance', 'organization-profile.json'));
  const check = runCli(root, ['check']);
  assert.equal(check.exitCode, 1);
  assert.match(check.output, /organization profile not found/);
});

test('check fails with exit 1 on an invalid manifest', () => {
  const m = validManifest();
  m.repos[0].visibility = 'internal';
  const root = scaffold(m);
  const result = runCli(root, ['check']);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /visibility/);
});
