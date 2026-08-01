import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hooksDirectory, installHooks } from '../install-hooks.mjs';

function installOpts(overrides = {}) {
  return {
    home: mkdtempSync(join(tmpdir(), 'install-hooks-home-')),
    install: ({ root }) => ({ path: root || '/repo/playbook-engineering', sha: 'a'.repeat(40) }),
    ...overrides,
  };
}

test('hooksDirectory is this checkout tools/agent-bot/hooks', () => {
  assert.match(hooksDirectory(), /tools[/\\]agent-bot[/\\]hooks$/);
});

test('installHooks writes global core.hooksPath to stable dispatch wrappers', () => {
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

  assert.match(result.hooksPath, /\.local\/share\/playbook-engineering\/hooks$/);
  assert.equal(result.previous, null);
  assert.equal(result.playbookRoot, '/Volumes/added_storage/Code/playbook-engineering');
  assert.deepEqual(calls.at(-1), ['config', '--global', 'core.hooksPath', result.hooksPath]);
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

test('installHooks prunes stale managed wrappers but preserves unrelated files', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-hooks-home-'));
  const source = mkdtempSync(join(tmpdir(), 'install-hooks-source-'));
  const wrapperDir = join(home, '.local', 'share', 'playbook-engineering', 'hooks');
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(source, 'pre-commit'), '#!/bin/sh\n');
  writeFileSync(join(wrapperDir, 'removed-hook'), '#!/bin/sh\n# Managed by playbook-install-hooks.\n');
  writeFileSync(join(wrapperDir, 'custom-hook'), '#!/bin/sh\n# user-owned\n');

  installHooks(installOpts({
    home,
    hooksPath: source,
    run: () => '',
  }));

  assert.equal(existsSync(join(wrapperDir, 'removed-hook')), false);
  assert.equal(existsSync(join(wrapperDir, 'custom-hook')), true);
  assert.match(readFileSync(join(wrapperDir, 'pre-commit'), 'utf8'), /Managed by playbook-install-hooks/);
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

test('installHooks fails when hooksPath is a file, not a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-hooks-'));
  const filePath = join(dir, 'not-a-dir');
  writeFileSync(filePath, 'i am a file\n');
  assert.throws(
    () => installHooks(installOpts({
      hooksPath: filePath,
      run: () => '',
    })),
    /must be a directory, not a file/,
  );
});
