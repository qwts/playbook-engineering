import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installGhShim } from '../install-gh-shim.mjs';
import { playbookHomePath } from '../playbook-home.mjs';

test('installGhShim writes playbook-home, config shim, and ~/.local/bin symlink', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-gh-'));
  const playbookRoot = join(home, 'playbook-engineering');
  mkdirSync(join(playbookRoot, 'tools', 'agent-bot'), { recursive: true });

  const result = installGhShim({ home, playbookRoot });

  assert.equal(readFileSync(playbookHomePath(home), 'utf8').trim(), playbookRoot);
  assert.match(readFileSync(result.shimPath, 'utf8'), /playbook-home/);
  assert.equal(realpathSync(result.localShim), realpathSync(result.shimPath));
  assert.match(readFileSync(join(home, '.zshenv'), 'utf8'), /\.config\/agent-bot\/bin/);
});

test('installGhShim replaces a prior ~/.local/bin/gh and is idempotent on zshenv', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-gh-'));
  const playbookRoot = join(home, 'playbook-engineering');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'gh'), '#!/bin/sh\n# stale\n', { mode: 0o755 });
  writeFileSync(join(home, '.zshenv'), 'export PATH="$HOME/.config/agent-bot/bin:$PATH"\n');

  const result = installGhShim({ home, playbookRoot });
  assert.equal(realpathSync(result.localShim), realpathSync(result.shimPath));
  assert.equal(result.zshenvUpdated, false);
  assert.equal(
    readFileSync(join(home, '.zshenv'), 'utf8'),
    'export PATH="$HOME/.config/agent-bot/bin:$PATH"\n',
  );
});

test('installGhShim does not bake a checkout path into the shim body', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-gh-'));
  const playbookRoot = '/Volumes/added_storage/Code/playbook-engineering';
  const result = installGhShim({ home, playbookRoot });
  const body = readFileSync(result.shimPath, 'utf8');
  assert.doesNotMatch(body, /Volumes\/added_storage/);
  assert.doesNotMatch(body, /Users\/user\/Code/);
  assert.match(body, /PLAYBOOK_HOME/);
  assert.match(body, /agent-bot\/playbook-home/);
});
