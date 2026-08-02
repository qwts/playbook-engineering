import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  changesetInputs,
  semanticReleaseCount,
} from '../../../.github/actions/changeset-release-count/semantic-release-count.mjs';

function changesetRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'release-lifecycle-'));
  mkdirSync(path.join(root, '.changeset'));
  writeFileSync(path.join(root, '.changeset', 'README.md'), '# Changesets\n');
  return root;
}

test('a generated projection after input consumption has zero semantic releases', () => {
  const root = changesetRoot();
  let invoked = false;
  const options = {
    root,
    statusFile: path.join(root, 'status.json'),
    runStatus: () => {
      invoked = true;
    },
  };
  assert.equal(semanticReleaseCount(options), 0);
  assert.equal(semanticReleaseCount(options), 0, 'repeated regeneration remains marker-free');
  assert.equal(invoked, false, 'Changesets is not asked to validate absent consumed inputs');
});

test('present changeset inputs use semantic Changesets output', () => {
  const root = changesetRoot();
  const statusFile = path.join(root, 'status.json');
  writeFileSync(path.join(root, '.changeset', 'change.md'), '---\n"example": patch\n---\n\nFix.\n');
  assert.deepEqual(changesetInputs(root), ['change.md']);
  const count = semanticReleaseCount({
    root,
    statusFile,
    runStatus: (output) => writeFileSync(output, JSON.stringify({ releases: [{ name: 'example' }] })),
  });
  assert.equal(count, 1);
});

test('invalid or malformed present changesets still fail closed', () => {
  const root = changesetRoot();
  const statusFile = path.join(root, 'status.json');
  writeFileSync(path.join(root, '.changeset', 'broken.md'), 'not valid changeset syntax');
  assert.throws(
    () => semanticReleaseCount({ root, statusFile, runStatus: () => { throw new Error('parse failed'); } }),
    /parse failed/,
  );
  assert.throws(
    () => semanticReleaseCount({
      root,
      statusFile,
      runStatus: (output) => writeFileSync(output, JSON.stringify({ changesets: [] })),
    }),
    /releases array/,
  );
  assert.equal(readFileSync(path.join(root, '.changeset', 'broken.md'), 'utf8'), 'not valid changeset syntax');
});

test('release lifecycle catalog covers every active or onboarding governed repository', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../governance/repos.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(
    readFileSync(new URL('../../../governance/release-lifecycles.json', import.meta.url), 'utf8'),
  );
  const governed = manifest.repos
    .filter((repo) => repo.status === 'active' || repo.status === 'onboarding')
    .map((repo) => `${manifest.account}/${repo.name}`)
    .sort();
  const cataloged = catalog.repositories.map((entry) => entry.repository).sort();
  assert.deepEqual(cataloged, governed);
  assert.equal(new Set(cataloged).size, cataloged.length);
});
