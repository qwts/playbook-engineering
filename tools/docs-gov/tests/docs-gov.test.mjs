import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { slugify } from '../lib/markdown.mjs';
import { globToRegExp } from '../lib/glob.mjs';
import { estimateTokens } from '../lib/tokens.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'docs-gov.mjs');

function runCli(fixture) {
  const root = path.join(here, 'fixtures', fixture);
  const report = path.join(mkdtempSync(path.join(tmpdir(), 'docs-gov-')), 'report.json');
  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync(process.execPath, [cli, '--root', root, '--report', report], {
      encoding: 'utf8',
    });
  } catch (error) {
    exitCode = error.status;
    output = `${error.stdout}${error.stderr}`;
  }
  return { exitCode, output, report: JSON.parse(readFileSync(report, 'utf8')) };
}

test('clean fixture: zero findings, exit 0', () => {
  const { exitCode, report } = runCli('clean');
  assert.equal(exitCode, 0);
  assert.deepEqual(report.findings, []);
  assert.equal(report.stats.docCount, 3);
});

test('violations fixture: every rule fires where expected', () => {
  const { exitCode, report } = runCli('violations');
  assert.equal(exitCode, 1);

  const got = new Map();
  for (const f of report.findings) {
    const key = `${f.rule} ${f.file}`;
    got.set(key, (got.get(key) ?? 0) + 1);
  }

  const expected = new Map([
    ['link-resolution docs/broken.md', 2], // dead file + dead anchor
    // Exactly one orphan: the unused `[unused-def]: docs/orphan.md` reference
    // definition in README confers no reachability, while docs/reflinked.md is
    // reachable through a *used* reference link and must not appear here.
    ['orphan-doc docs/orphan.md', 1],
    ['stale-path docs/broken.md', 1], // src/gone.mjs; src/present.mjs must not fire
    ['heading-structure docs/structure.md', 3], // second H1, level skip, depth
    ['heading-structure docs/orphan.md', 1], // first heading is H2
    ['front-loaded-summary docs/structure.md', 1],
    // ADR-0001 fires only for Status: the Resolution spec excludes it, so a
    // second finding here means `exclude` is being ignored. ADR-0003 is also
    // excluded and must not appear for Resolution at all.
    ['required-fields docs/adr/ADR-0001.md', 1], // Status missing
    ['required-fields docs/adr/ADR-0002.md', 2], // Status unparseable + Resolution missing (in exclude-scoped spec)
    ['token-budget docs/heavy.md', 1], // over default budget
    ['token-budget docs/big.md', 1], // raised override without a reason
    ['token-budget docs/good.md', 1], // far under override — bank the win
    ['token-budget docs/nonexistent.md', 1], // override points at nothing
    ['token-budget AGENTS.md', 2], // ctx-over above budget, ctx-bank far below
    ['positional-reference docs/broken.md', 1],
    ['unresolved-placeholder docs/broken.md', 1],
    ['duplicate-statement README.md', 1], // duplicated in docs/good.md
    ['terminology docs/broken.md', 1],
  ]);

  assert.deepEqual(
    Object.fromEntries([...got.entries()].sort()),
    Object.fromEntries([...expected.entries()].sort()),
  );
});

test('violations fixture: messages carry the pointers a fixer needs', () => {
  const { report } = runCli('violations');
  const messages = report.findings.map((f) => f.message).join('\n');
  assert.match(messages, /missing\.md/);
  assert.match(messages, /nonexistent-section/);
  assert.match(messages, /src\/gone\.mjs/);
  assert.match(messages, /docs\/good\.md:/); // duplicate lists both locations
  assert.match(messages, /lightbox/); // terminology names the canonical term
  assert.match(messages, /ctx-over/);
});

test('decision-series fixture: number uniqueness and issue-derived provenance', () => {
  const { exitCode, report } = runCli('decision-series');
  assert.equal(exitCode, 1);

  // Only the decision-number rule fires, and only on the three records that
  // should: a number/issue mismatch, a duplicated number, and an issue in the
  // wrong repo. The grandfathered ENG-0002 (whose number ≠ its issue), the
  // clean ENG-0050, and the first holder of the duplicated number stay silent.
  const byFile = new Map();
  for (const f of report.findings) {
    assert.equal(f.rule, 'decision-number', `unexpected rule ${f.rule} on ${f.file}`);
    byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...byFile.entries()].sort()), {
    'docs/decisions/ENG-0051-mismatch.md': 1,
    'docs/decisions/ENG-0052-second.md': 1,
    'docs/decisions/ENG-0053-wrongrepo.md': 1,
  });

  const messages = report.findings.map((f) => f.message).join('\n');
  assert.match(messages, /should be ENG-0099/); // provenance names the correct number
  assert.match(messages, /used by 2 records/); // duplicate names the collision
  assert.match(messages, /qwts\/photos/); // home-repo guard names the offending repo
});

test('slugify matches GitHub anchors, including stripped emoji', () => {
  assert.equal(slugify('Planning Phase'), 'planning-phase');
  assert.equal(slugify('🔍 Planning Phase (Documents 1-6)'), '-planning-phase-documents-1-6');
  assert.equal(slugify('CI/CD Planning'), 'cicd-planning');
  assert.equal(slugify('`code` and *emphasis*'), 'code-and-emphasis');
});

test('glob patterns match path segments correctly', () => {
  assert.ok(globToRegExp('docs/**/*.md').test('docs/a/b/c.md'));
  assert.ok(globToRegExp('docs/**/*.md').test('docs/top.md'));
  assert.ok(!globToRegExp('docs/**/*.md').test('src/a.md'));
  assert.ok(globToRegExp('README.md').test('README.md'));
  assert.ok(!globToRegExp('README.md').test('docs/README.md'));
  assert.ok(globToRegExp('docs/decisions/ENG-*.md').test('docs/decisions/ENG-0004-x.md'));
  assert.ok(!globToRegExp('docs/decisions/ENG-*.md').test('docs/decisions/README.md'));
});

test('token estimate is bytes/4, rounded up', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(''), 0);
});
