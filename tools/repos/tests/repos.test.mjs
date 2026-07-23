import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

test('extractBlock round-trips what renderBlock writes', () => {
  const doc = `# Doc\n\n${BEGIN_MARKER}\n${END_MARKER}\n`;
  const spliced = spliceBlock(doc, validManifest());
  assert.equal(extractBlock(spliced), renderBlock(validManifest()));
});

test('spliceBlock throws when the markers are absent', () => {
  assert.throws(() => spliceBlock('# Doc with no markers\n', validManifest()), /markers not found/);
});

// --- CLI ----------------------------------------------------------------

function scaffold(manifest) {
  const root = mkdtempSync(path.join(tmpdir(), 'repos-'));
  mkdirSync(path.join(root, 'governance'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'reference'), { recursive: true });
  writeFileSync(path.join(root, 'governance', 'repos.json'), JSON.stringify(manifest, null, 2));
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

test('check fails with exit 1 on an invalid manifest', () => {
  const m = validManifest();
  m.repos[0].visibility = 'internal';
  const root = scaffold(m);
  const result = runCli(root, ['check']);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /visibility/);
});
