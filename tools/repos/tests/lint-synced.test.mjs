import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GOVERNED_HARNESS_FILES } from '../lib/baseline-files.mjs';
import { lintSyncedFiles } from '../lint-synced.mjs';

const fixtureRoot = fileURLToPath(new URL('fixtures/lint-synced/', import.meta.url));

test('the Complete suite runs the governed harness parity gate', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

  assert.equal(packageJson.scripts['lint:synced'], 'node tools/repos/lint-synced.mjs');
  assert.match(workflow, /Complete suite[\s\S]*npm run lint:synced/u);
});

test('the canonical governed harness inventory passes the upstream parity gate', async () => {
  const result = await lintSyncedFiles({ paths: GOVERNED_HARNESS_FILES });

  assert.equal(result.errorCount, 0, result.output);
});

test('an unused import in a governed module fails with the ESLint rule', async () => {
  const result = await lintSyncedFiles({
    root: fixtureRoot,
    paths: ['unused-import.mjs'],
  });

  assert.ok(result.errorCount > 0);
  assert.match(result.output, /readFileSync/u);
  assert.match(result.output, /no-unused-vars/u);
});

test('governed JSON and bash files receive their native syntax checks', async () => {
  const result = await lintSyncedFiles({
    root: fixtureRoot,
    paths: ['invalid.json', 'invalid.sh'],
  });

  assert.equal(result.errorCount, 2);
  assert.match(result.output, /invalid\.json: invalid JSON/u);
  assert.match(result.output, /invalid\.sh: bash -n failed/u);
});

test('zsh syntax is checked when zsh is available', async () => {
  const calls = [];
  const result = await lintSyncedFiles({
    root: fixtureRoot,
    paths: ['valid.zsh'],
    spawn(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.errorCount, 0, result.output);
  assert.deepEqual(calls, [{
    command: 'zsh',
    args: ['-n', path.join(fixtureRoot, 'valid.zsh')],
  }]);
});

test('a missing zsh executable skips only zsh syntax validation', async () => {
  const result = await lintSyncedFiles({
    root: fixtureRoot,
    paths: ['valid.zsh'],
    spawn() {
      const error = new Error('spawnSync zsh ENOENT');
      error.code = 'ENOENT';
      return { status: null, stdout: '', stderr: '', error };
    },
  });

  assert.equal(result.errorCount, 0, result.output);
});
