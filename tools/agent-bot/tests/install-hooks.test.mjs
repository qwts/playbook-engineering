import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hooksDirectory, installHooks } from '../install-hooks.mjs';

function installOpts(overrides = {}) {
  return {
    writeHome: (root) => ({ path: '/tmp/playbook-home', root }),
    ...overrides,
  };
}

test('hooksDirectory is this checkout tools/agent-bot/hooks', () => {
  assert.match(hooksDirectory(), /tools[/\\]agent-bot[/\\]hooks$/);
});

test('installHooks writes global core.hooksPath to the given absolute hooks dir', () => {
  const hooksPath = join(mkdtempSync(join(tmpdir(), 'install-hooks-')), 'hooks');
  mkdirSync(hooksPath);
  const calls = [];
  const result = installHooks(installOpts({
    hooksPath,
    playbookRoot: '/Volumes/added_storage/Code/playbook-engineering',
    run: (args) => {
      calls.push(args);
      if (args.includes('--get')) {
        const err = new Error('not set');
        err.status = 1;
        throw err;
      }
      return '';
    },
  }));

  assert.equal(result.hooksPath, hooksPath);
  assert.equal(result.previous, null);
  assert.equal(result.playbookRoot, '/Volumes/added_storage/Code/playbook-engineering');
  assert.deepEqual(calls.at(-1), ['config', '--global', 'core.hooksPath', hooksPath]);
});

test('installHooks reports a previous path when replacing one', () => {
  const hooksPath = join(mkdtempSync(join(tmpdir(), 'install-hooks-')), 'hooks');
  mkdirSync(hooksPath);
  const result = installHooks(installOpts({
    hooksPath,
    run: (args) => {
      if (args.includes('--get')) return '/old/hooks';
      return '';
    },
  }));
  assert.equal(result.previous, '/old/hooks');
});

test('installHooks fails closed when the hooks directory is missing', () => {
  assert.throws(
    () => installHooks(installOpts({
      hooksPath: join(tmpdir(), 'no-such-hooks-dir'),
      run: () => '',
    })),
    /hooks directory missing/,
  );
});
