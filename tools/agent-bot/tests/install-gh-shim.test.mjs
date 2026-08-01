import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installGhShim } from '../install-gh-shim.mjs';
const installed = ({ root }) => ({ path: root, sha: 'a'.repeat(40) });

test('installGhShim installs a pinned launcher and ~/.local/bin symlink', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-gh-'));
  const playbookRoot = join(home, 'playbook-engineering');
  mkdirSync(join(playbookRoot, 'tools', 'agent-bot'), { recursive: true });

  const result = installGhShim({ home, playbookRoot, install: installed });

  assert.equal(result.playbookRoot, playbookRoot);
  assert.match(readFileSync(result.shimPath, 'utf8'), /playbook-engineering/);
  assert.equal(realpathSync(result.localShim), realpathSync(result.shimPath));
  assert.match(readFileSync(join(home, '.zshenv'), 'utf8'), /\.config\/agent-bot\/bin/);
});

test('installGhShim replaces a prior agent-bot symlink and is idempotent on zshenv', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-gh-'));
  const playbookRoot = join(home, 'playbook-engineering');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const agentBin = join(home, '.config', 'agent-bot', 'bin');
  mkdirSync(agentBin, { recursive: true });
  const staleShim = join(agentBin, 'gh');
  writeFileSync(staleShim, '#!/bin/sh\n# stale agent-bot shim\n', { mode: 0o755 });
  symlinkSync(staleShim, join(home, '.local', 'bin', 'gh'));
  writeFileSync(join(home, '.zshenv'), 'export PATH="$HOME/.config/agent-bot/bin:$PATH"\n');

  const result = installGhShim({ home, playbookRoot, install: installed });
  assert.equal(realpathSync(result.localShim), realpathSync(result.shimPath));
  assert.equal(result.zshenvUpdated, false);
  assert.equal(
    readFileSync(join(home, '.zshenv'), 'utf8'),
    'export PATH="$HOME/.config/agent-bot/bin:$PATH"\n',
  );
});

test('installGhShim aborts when ~/.local/bin/gh is a real file, not an agent-bot shim', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-gh-'));
  const playbookRoot = join(home, 'playbook-engineering');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'gh'), '#!/bin/sh\necho real gh\n', {
    mode: 0o755,
  });
  assert.throws(
    () => installGhShim({ home, playbookRoot, install: installed }),
    /real file/,
  );
  // The real gh is left intact.
  assert.match(readFileSync(join(home, '.local', 'bin', 'gh'), 'utf8'), /real gh/);
});

test('installGhShim aborts when ~/.local/bin/gh is a foreign symlink', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-gh-'));
  const playbookRoot = join(home, 'playbook-engineering');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const elsewhere = join(home, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'gh'), '#!/bin/sh\necho foreign\n', { mode: 0o755 });
  symlinkSync(join(elsewhere, 'gh'), join(home, '.local', 'bin', 'gh'));
  assert.throws(
    () => installGhShim({ home, playbookRoot, install: installed }),
    /not an agent-bot shim/,
  );
});

test('installGhShim does not bake a checkout path into the shim body', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-gh-'));
  const playbookRoot = '/Volumes/added_storage/Code/playbook-engineering';
  const result = installGhShim({ home, playbookRoot, install: installed });
  const body = readFileSync(result.shimPath, 'utf8');
  assert.doesNotMatch(body, /Volumes\/added_storage/);
  assert.doesNotMatch(body, /Users\/user\/Code/);
  assert.doesNotMatch(body, /PLAYBOOK_HOME/);
  assert.doesNotMatch(body, /agent-bot\/playbook-home/);
  assert.match(body, /\.local\/bin\/playbook-engineering/);
});
